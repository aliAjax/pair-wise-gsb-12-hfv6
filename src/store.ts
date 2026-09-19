import { defineStore } from "pinia";
import type {
  Conflict,
  DispatchTask,
  ExpenseLine,
  FeeType,
  PersistedState,
  Revision,
  SettlementOrder
} from "./types";
import { DETAIL_FEE_TYPES, FEE_TYPE_LABELS, TASK_STATUS } from "./types";
import { buildLedger, lineLabel, projectEffective, round2, validateOrder } from "./validation";

const STORAGE_KEY = "dfwlfront-3-settlement-v1";

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function newLine(feeType: FeeType = DETAIL_FEE_TYPES[0]): ExpenseLine {
  return { id: uid("line"), feeType, name: "", amount: 0, ticketNo: "", ticketAmount: 0 };
}

function seedState(): PersistedState {
  const now = Date.now();
  const tasks: DispatchTask[] = [
    {
      id: "seed-task-1",
      code: "RW-1001",
      vehicle: "沪A-82L6",
      driver: "董飞",
      zone: "城北",
      task: "商超补货",
      status: "执行中",
      createdAt: new Date(now - 3 * 3600_000).toISOString()
    },
    {
      id: "seed-task-2",
      code: "RW-1002",
      vehicle: "沪B-73K9",
      driver: "周航",
      zone: "城东",
      task: "医药配送",
      status: "已完成",
      createdAt: new Date(now - 28 * 3600_000).toISOString()
    },
    {
      id: "seed-task-3",
      code: "RW-1003",
      vehicle: "沪C-55D2",
      driver: "梁坤",
      zone: "城南",
      task: "冷链仓配",
      status: "已完成",
      createdAt: new Date(now - 52 * 3600_000).toISOString()
    }
  ];

  // 已确认回单：快照冻结 + 一条补录修订，演示修订链与原值保留
  const confirmed: SettlementOrder = {
    id: "seed-order-1",
    code: "HD-2001",
    taskId: "seed-task-2",
    status: "confirmed",
    createdAt: new Date(now - 26 * 3600_000).toISOString(),
    submittedAt: new Date(now - 25 * 3600_000).toISOString(),
    confirmedAt: new Date(now - 24 * 3600_000).toISOString(),
    remark: "城东医药配送，全程高速",
    startMileage: 45200,
    endMileage: 45368,
    fuelLiters: 22.5,
    tollAmount: 45,
    tollTicketNo: "GL090228",
    receivable: 2680,
    lines: [
      {
        id: "seed-line-1",
        feeType: "fuel",
        name: "0号柴油",
        amount: 800,
        ticketNo: "YP100221",
        ticketAmount: 800
      }
    ],
    revisions: [
      {
        id: "seed-rev-1",
        seq: 1,
        reason: "客户现场补报停车费",
        createdAt: new Date(now - 20 * 3600_000).toISOString(),
        addedLines: [
          {
            id: "seed-line-2",
            feeType: "parking",
            name: "医院地库停车",
            amount: 35,
            ticketNo: "PK778812",
            ticketAmount: 35
          }
        ],
        adjustments: []
      }
    ],
    snapshot: {
      startMileage: 45200,
      endMileage: 45368,
      actualMileage: 168,
      fuelLiters: 22.5,
      tollAmount: 45,
      tollTicketNo: "GL090228",
      receivable: 2680,
      lines: [
        {
          id: "seed-line-1",
          feeType: "fuel",
          name: "0号柴油",
          amount: 800,
          ticketNo: "YP100221",
          ticketAmount: 800
        }
      ],
      totalExpense: 845,
      frozenAt: new Date(now - 24 * 3600_000).toISOString()
    }
  };

  // 草稿回单：故意包含里程倒挂、重复费用项、票明不一致，演示阻止提交
  const draft: SettlementOrder = {
    id: "seed-order-2",
    code: "HD-2002",
    taskId: "seed-task-3",
    status: "draft",
    createdAt: new Date(now - 30 * 3600_000).toISOString(),
    remark: "单据待核对",
    startMileage: 31000,
    endMileage: 30980,
    fuelLiters: 20,
    tollAmount: 0,
    tollTicketNo: "",
    receivable: null,
    lines: [
      { id: "seed-line-3", feeType: "fuel", name: "0号柴油", amount: 720, ticketNo: "YP200311", ticketAmount: 720 },
      { id: "seed-line-4", feeType: "fuel", name: "途中加油", amount: 300, ticketNo: "YP200312", ticketAmount: 300 },
      { id: "seed-line-5", feeType: "parking", name: "园区停车", amount: 60, ticketNo: "PK300118", ticketAmount: 50 }
    ],
    revisions: []
  };

  return {
    tasks,
    orders: [confirmed, draft],
    seqTask: 1004,
    seqOrder: 2003
  };
}

function load(): PersistedState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return seedState();
  try {
    const parsed = JSON.parse(raw) as PersistedState;
    if (!Array.isArray(parsed.tasks) || !Array.isArray(parsed.orders)) return seedState();
    return parsed;
  } catch {
    return seedState();
  }
}

/** 供脚本测试使用的种子数据 */
export function seedData(): PersistedState {
  return JSON.parse(JSON.stringify(seedState())) as PersistedState;
}

export interface RevisionDraft {
  reason: string;
  added: ExpenseLine[];
  adjustments: Array<{
    lineId: string; // __toll__ 表示顶层路桥费
    amount: number | null;
    ticketNo: string;
    ticketAmount: number | null;
  }>;
}

export const useSettlementStore = defineStore("settlement", {
  state: () => {
    const initial = load();
    return {
      tasks: initial.tasks as DispatchTask[],
      orders: initial.orders as SettlementOrder[],
      seqTask: initial.seqTask as number,
      seqOrder: initial.seqOrder as number
    };
  },

  getters: {
    ordersByTask: (state) => {
      const map = new Map<string, SettlementOrder[]>();
      for (const order of [...state.orders].sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
      )) {
        const list = map.get(order.taskId) ?? [];
        list.push(order);
        map.set(order.taskId, list);
      }
      return map;
    },
    effective: () => (order: SettlementOrder) => projectEffective(order)
  },

  actions: {
    persist() {
      const data: PersistedState = {
        tasks: this.tasks,
        orders: this.orders,
        seqTask: this.seqTask,
        seqOrder: this.seqOrder
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    },

    addTask(payload: {
      vehicle: string;
      driver: string;
      zone: string;
      task: string;
      status: (typeof TASK_STATUS)[number];
    }): DispatchTask {
      const code = `RW-${this.seqTask++}`;
      const task: DispatchTask = {
        id: uid("task"),
        code,
        vehicle: payload.vehicle,
        driver: payload.driver,
        zone: payload.zone,
        task: payload.task,
        status: payload.status,
        createdAt: new Date().toISOString()
      };
      this.tasks.unshift(task);
      this.persist();
      return task;
    },

    setTaskStatus(taskId: string, status: (typeof TASK_STATUS)[number]) {
      const task = this.tasks.find((t) => t.id === taskId);
      if (task) {
        task.status = status;
        this.persist();
      }
    },

    createOrder(taskId: string): SettlementOrder {
      const order: SettlementOrder = {
        id: uid("order"),
        code: `HD-${this.seqOrder++}`,
        taskId,
        status: "draft",
        createdAt: new Date().toISOString(),
        remark: "",
        startMileage: null,
        endMileage: null,
        fuelLiters: null,
        tollAmount: null,
        tollTicketNo: "",
        receivable: null,
        lines: [newLine("fuel")],
        revisions: []
      };
      this.orders.unshift(order);
      this.persist();
      return order;
    },

    updateOrder(id: string, patch: Partial<SettlementOrder>) {
      const order = this.orders.find((o) => o.id === id);
      if (!order || order.status === "confirmed") return;
      Object.assign(order, patch);
      this.persist();
    },

    addDraftLine(id: string) {
      const order = this.orders.find((o) => o.id === id);
      if (!order || order.status === "confirmed") return;
      const used = new Set(order.lines.map((l) => l.feeType));
      const next = DETAIL_FEE_TYPES.find((t) => !used.has(t)) ?? "other";
      order.lines.push(newLine(next));
      this.persist();
    },

    updateDraftLine(id: string, lineId: string, patch: Partial<ExpenseLine>) {
      const order = this.orders.find((o) => o.id === id);
      if (!order || order.status === "confirmed") return;
      const line = order.lines.find((l) => l.id === lineId);
      if (line) {
        Object.assign(line, patch);
        this.persist();
      }
    },

    removeDraftLine(id: string, lineId: string) {
      const order = this.orders.find((o) => o.id === id);
      if (!order || order.status === "confirmed") return;
      order.lines = order.lines.filter((l) => l.id !== lineId);
      this.persist();
    },

    removeOrder(id: string) {
      const order = this.orders.find((o) => o.id === id);
      if (!order || order.status === "confirmed") return; // 已确认单据不可删除
      this.orders = this.orders.filter((o) => o.id !== id);
      this.persist();
    },

    /** 提交校验：有冲突则阻止并返回冲突清单 */
    submitOrder(id: string): Conflict[] {
      const order = this.orders.find((o) => o.id === id);
      if (!order || order.status === "confirmed") return [];
      const result = validateOrder(order, this.orders, this.tasks);
      if (!result.valid) return result.conflicts;
      order.status = "submitted";
      order.submittedAt = order.submittedAt ?? new Date().toISOString();
      this.persist();
      return [];
    },

    /** 结算确认：再次校验通过后冻结费用快照 */
    confirmOrder(id: string): Conflict[] {
      const order = this.orders.find((o) => o.id === id);
      if (!order || order.status === "confirmed") return [];
      const result = validateOrder(order, this.orders, this.tasks);
      if (!result.valid) {
        order.status = "draft";
        return result.conflicts;
      }
      const start = Number(order.startMileage) || 0;
      const end = Number(order.endMileage) || 0;
      order.snapshot = {
        startMileage: start,
        endMileage: end,
        actualMileage: end - start,
        fuelLiters: Number(order.fuelLiters) || 0,
        tollAmount: Number(order.tollAmount) || 0,
        tollTicketNo: order.tollTicketNo.trim(),
        receivable: Number(order.receivable) || 0,
        lines: order.lines.map((l) => ({
          id: l.id,
          feeType: l.feeType,
          name: l.name,
          amount: round2(Number(l.amount) || 0),
          ticketNo: l.ticketNo.trim(),
          ticketAmount: round2(Number(l.ticketAmount) || 0)
        })),
        totalExpense: round2(
          (Number(order.tollAmount) || 0) +
            order.lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0)
        ),
        frozenAt: new Date().toISOString()
      };
      order.status = "confirmed";
      order.confirmedAt = new Date().toISOString();
      this.persist();
      return [];
    },

    validateRevision(id: string, draft: RevisionDraft): Conflict[] {
      const order = this.orders.find((o) => o.id === id);
      const conflicts: Conflict[] = [];
      if (!order || order.status !== "confirmed") return conflicts;
      const eff = projectEffective(order);

      const existingTypes = new Set(eff.lines.map((l) => l.feeType));
      if (eff.toll && eff.toll.amount > 0) existingTypes.add("toll");
      const existingTickets = new Set<string>();
      if (eff.toll?.ticketNo) existingTickets.add(eff.toll.ticketNo);
      eff.lines.forEach((l) => l.ticketNo && existingTickets.add(l.ticketNo));
      const ledger = buildLedger(this.orders.filter((o) => o.id !== id));

      const revisionTickets = new Set<string>();
      for (const line of draft.added) {
        const amount = Number(line.amount) || 0;
        const ticketAmount = Number(line.ticketAmount) || 0;
        const ticketNo = line.ticketNo.trim();
        const name = lineLabel(line);
        if (amount <= 0) {
          conflicts.push({ code: "missing", message: `补录「${FEE_TYPE_LABELS[line.feeType]}」金额必须大于 0` });
          continue;
        }
        if (line.feeType === "toll" || existingTypes.has(line.feeType)) {
          conflicts.push({
            code: "duplicate-line",
            message: `费用项重复：「${FEE_TYPE_LABELS[line.feeType]}」已在原结算/修订中报销，同一费用项不能再次补录，如需变更请使用调整`
          });
        }
        if (!ticketNo) {
          conflicts.push({ code: "ticket-missing", message: `补录「${name}」缺少票据号` });
        } else if (round2(ticketAmount) !== round2(amount)) {
          conflicts.push({
            code: "ticket-mismatch",
            message: `补录「${name}」票据 ${ticketNo} 票面 ${ticketAmount.toFixed(2)} 元与明细 ${amount.toFixed(2)} 元不一致`
          });
        }
        if (ticketNo) {
          if (revisionTickets.has(ticketNo) || existingTickets.has(ticketNo)) {
            conflicts.push({ code: "duplicate-ticket", message: `票据号 ${ticketNo} 在本单中重复` });
          } else if (ledger.ticketNos.has(ticketNo)) {
            conflicts.push({ code: "duplicate-ticket", message: `票据号 ${ticketNo} 已在其他结算单报销` });
          }
          revisionTickets.add(ticketNo);
        }
      }

      const all = [
        ...(eff.toll ? [{ id: "__toll__", feeType: "toll" as FeeType, name: "路桥费" }] : []),
        ...eff.lines.map((l) => ({ id: l.id, feeType: l.feeType, name: l.name }))
      ];
      for (const adj of draft.adjustments) {
        const target = all.find((l) => l.id === adj.lineId);
        if (!target) continue;
        const amount = Number(adj.amount);
        const ticketAmount = Number(adj.ticketAmount);
        const ticketNo = adj.ticketNo.trim();
        if (Number.isNaN(amount) || amount < 0) {
          conflicts.push({ code: "missing", message: `调整「${target.name}」金额无效` });
          continue;
        }
        if (!ticketNo) {
          conflicts.push({ code: "ticket-missing", message: `调整「${target.name}」缺少票据号` });
        } else if (target.feeType !== "toll" && round2(ticketAmount) !== round2(amount)) {
          conflicts.push({
            code: "ticket-mismatch",
            message: `调整「${target.name}」票面 ${ticketAmount.toFixed(2)} 元与明细 ${amount.toFixed(2)} 元不一致`
          });
        }
        if (ticketNo && !existingTickets.has(ticketNo)) {
          if (revisionTickets.has(ticketNo) || ledger.ticketNos.has(ticketNo)) {
            conflicts.push({ code: "duplicate-ticket", message: `票据号 ${ticketNo} 与其他票据冲突` });
          }
          revisionTickets.add(ticketNo);
        }
      }

      if (!draft.reason.trim()) {
        conflicts.push({ code: "missing", message: "修订原因必填，以备核对" });
      }
      if (draft.added.length === 0 && draft.adjustments.length === 0) {
        conflicts.push({ code: "missing", message: "修订至少包含一条补录票据或金额调整" });
      }
      return conflicts;
    },

    /** 追加修订：原值保留在快照与前序修订中，不覆盖任何历史 */
    addRevision(id: string, draft: RevisionDraft): Conflict[] {
      const order = this.orders.find((o) => o.id === id);
      if (!order || order.status !== "confirmed") return [];
      const conflicts = this.validateRevision(id, draft);
      if (conflicts.length > 0) return conflicts;

      const eff = projectEffective(order);
      const current = new Map<string, { amount: number; ticketNo: string; ticketAmount: number }>();
      if (eff.toll) current.set("__toll__", { amount: eff.toll.amount, ticketNo: eff.toll.ticketNo, ticketAmount: eff.toll.ticketAmount });
      eff.lines.forEach((l) => current.set(l.id, { amount: l.amount, ticketNo: l.ticketNo, ticketAmount: l.ticketAmount }));

      const revision: Revision = {
        id: uid("rev"),
        seq: order.revisions.length + 1,
        reason: draft.reason.trim(),
        createdAt: new Date().toISOString(),
        addedLines: draft.added.map((l) => ({
          id: uid("line"),
          feeType: l.feeType,
          name: l.name.trim(),
          amount: round2(Number(l.amount) || 0),
          ticketNo: l.ticketNo.trim(),
          ticketAmount: round2(Number(l.ticketAmount) || 0)
        })),
        adjustments: draft.adjustments
          .map((adj) => {
            const prev = current.get(adj.lineId);
            if (!prev) return null;
            return {
              lineId: adj.lineId,
              prevAmount: prev.amount,
              prevTicketNo: prev.ticketNo,
              prevTicketAmount: prev.ticketAmount,
              amount: round2(Number(adj.amount) || 0),
              ticketNo: adj.ticketNo.trim(),
              ticketAmount: round2(Number(adj.ticketAmount) || 0)
            };
          })
          .filter((x): x is Revision["adjustments"][number] => x !== null)
      };

      order.revisions.push(revision);
      this.persist();
      return [];
    },

    blankRevisionLine(): ExpenseLine {
      return newLine("other");
    }
  }
});
