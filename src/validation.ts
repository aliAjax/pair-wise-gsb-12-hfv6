import type {
  Conflict,
  DispatchTask,
  EffectiveLine,
  EffectiveOrder,
  ExpenseLine,
  FeeType,
  SettlementOrder,
  ValidationResult
} from "./types";
import { FEE_TYPE_LABELS } from "./types";

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function lineLabel(line: Pick<ExpenseLine, "feeType" | "name">): string {
  return line.name?.trim() ? line.name : FEE_TYPE_LABELS[line.feeType];
}

/** 已确认结算单的报销台账：任务 + 费用项 → 已报销（含修订链投影后的全部行） */
export function buildLedger(orders: SettlementOrder[]) {
  const taskFee = new Set<string>();
  const ticketNos = new Set<string>();
  for (const order of orders) {
    if (order.status !== "confirmed" || !order.snapshot) continue;
    const eff = projectEffective(order);
    const claim = (line: EffectiveLine) => {
      if (line.amount > 0) taskFee.add(`${order.taskId}::${line.feeType}`);
      const no = line.ticketNo.trim();
      if (no) ticketNos.add(no);
    };
    if (eff.toll) claim(eff.toll);
    eff.lines.forEach(claim);
  }
  return { taskFee, ticketNos };
}

/** 校验待提交结算单，列出全部冲突项；有任意冲突即阻止提交 */
export function validateOrder(
  draft: SettlementOrder,
  orders: SettlementOrder[],
  tasks: DispatchTask[]
): ValidationResult {
  const conflicts: Conflict[] = [];
  const task = tasks.find((t) => t.id === draft.taskId);

  // —— 必填项与非负 ——
  const required: Array<[string, number | null]> = [
    ["起始里程", draft.startMileage],
    ["结束里程", draft.endMileage],
    ["实际油耗（升）", draft.fuelLiters],
    ["路桥费", draft.tollAmount],
    ["应收金额", draft.receivable]
  ];
  for (const [label, value] of required) {
    if (value === null || Number.isNaN(value) || value < 0) {
      conflicts.push({ code: "missing", message: `${label}缺失或为负数` });
    }
  }

  const start = Number(draft.startMileage) || 0;
  const end = Number(draft.endMileage) || 0;

  // —— 里程倒挂：同一张回单结束表不得小于起始表 ——
  if (
    draft.startMileage !== null &&
    draft.endMileage !== null &&
    end < start
  ) {
    conflicts.push({
      code: "mileage-internal",
      message: `里程倒挂：结束表读数 ${end} km 小于起始表读数 ${start} km（实际里程 ${end - start} km）`
    });
  }

  // —— 里程倒挂：与同车其他已提交/已确认回单的时间序比较 ——
  if (task && draft.endMileage !== null && end >= start) {
    for (const other of orders) {
      if (other.id === draft.id || other.status === "draft" || !other.snapshot) continue;
      const otherTask = tasks.find((t) => t.id === other.taskId);
      if (!otherTask || otherTask.vehicle !== task.vehicle) continue;
      const otherStart = other.snapshot.startMileage;
      const otherEnd = other.snapshot.endMileage;
      const otherCreated = Date.parse(other.createdAt);
      const selfCreated = Date.parse(draft.createdAt);
      // 对方是本单之前的行程：本单起始表不得小于对方结束表
      if (otherCreated <= selfCreated && start < otherEnd) {
        conflicts.push({
          code: "mileage-overlap",
          message: `里程倒挂：本单起始 ${start} km 小于同车 ${otherTask.vehicle} 回单 ${other.code} 已记录的结束里程 ${otherEnd} km`
        });
      }
      // 对方是本单之后的行程：本单结束表不得大于对方起始表
      if (otherCreated > selfCreated && end > otherStart) {
        conflicts.push({
          code: "mileage-overlap",
          message: `里程倒挂：本单结束 ${end} km 大于同车 ${otherTask.vehicle} 后续回单 ${other.code} 的起始里程 ${otherStart} km`
        });
      }
    }
  }

  // 收集本单全部费用项（顶层路桥费 + 明细行）
  type Entry = { feeType: FeeType; name: string; amount: number; ticketNo: string; ticketAmount: number };
  const entries: Entry[] = [];
  const toll = Number(draft.tollAmount) || 0;
  entries.push({
    feeType: "toll",
    name: "路桥费",
    amount: toll,
    ticketNo: draft.tollTicketNo.trim(),
    ticketAmount: toll
  });
  for (const line of draft.lines) {
    entries.push({
      feeType: line.feeType,
      name: lineLabel(line),
      amount: Number(line.amount) || 0,
      ticketNo: line.ticketNo.trim(),
      ticketAmount: Number(line.ticketAmount) || 0
    });
  }

  // —— 同一单内同一费用项不得重复 ——
  const seenInDraft = new Map<FeeType, string>();
  for (const e of entries) {
    if (e.amount <= 0 && !e.ticketNo) continue; // 空行不校验
    const prev = seenInDraft.get(e.feeType);
    if (prev) {
      conflicts.push({
        code: "duplicate-line",
        message: `费用项重复：${FEE_TYPE_LABELS[e.feeType]} 在本单中出现多次（${prev} 与 ${e.name}），同一任务同一费用项不得重复报销`
      });
    } else {
      seenInDraft.set(e.feeType, e.name);
    }
  }

  // —— 跨单：同一任务同一费用项已在已确认结算单报销 ——
  const ledger = buildLedger(orders.filter((o) => o.id !== draft.id));
  for (const e of entries) {
    if (e.amount <= 0) continue;
    if (ledger.taskFee.has(`${draft.taskId}::${e.feeType}`)) {
      conflicts.push({
        code: "duplicate-task",
        message: `重复报销：任务下的「${FEE_TYPE_LABELS[e.feeType]}」已在已确认结算单中报销（${e.name}），请通过补录修订处理`
      });
    }
  }

  // —— 票据：缺号、票面金额与明细不一致、票据号重复 ——
  const localTicketNos = new Map<string, string>();
  for (const e of entries) {
    if (e.amount <= 0) continue;
    if (!e.ticketNo) {
      conflicts.push({
        code: "ticket-missing",
        message: `${FEE_TYPE_LABELS[e.feeType]}（${e.name}）金额 ${e.amount.toFixed(2)} 元缺少票据号`
      });
      continue;
    }
    // 顶层路桥费不做票面金额对照（票面即填写值）；其余行校验票明一致
    if (e.feeType !== "toll" && round2(e.ticketAmount) !== round2(e.amount)) {
      conflicts.push({
        code: "ticket-mismatch",
        message: `票据金额与明细不一致：${FEE_TYPE_LABELS[e.feeType]}（${e.name}）票据号 ${e.ticketNo} 票面 ${e.ticketAmount.toFixed(2)} 元，明细金额 ${e.amount.toFixed(2)} 元，差额 ${(e.amount - e.ticketAmount).toFixed(2)} 元`
      });
    }
    const prevName = localTicketNos.get(e.ticketNo);
    if (prevName) {
      conflicts.push({
        code: "duplicate-ticket",
        message: `票据号重复：${e.ticketNo} 已用于 ${prevName}，同一张票不得重复报销`
      });
    } else {
      localTicketNos.set(e.ticketNo, e.name);
    }
    if (ledger.ticketNos.has(e.ticketNo)) {
      conflicts.push({
        code: "duplicate-ticket",
        message: `票据号 ${e.ticketNo}（${FEE_TYPE_LABELS[e.feeType]}）已在其他已确认结算单中报销`
      });
    }
  }

  return { valid: conflicts.length === 0, conflicts };
}

/** 结算单生效值投影：快照原值 + 修订链 */
export function projectEffective(order: SettlementOrder): EffectiveOrder {
  const base = order.snapshot;
  const start = base ? base.startMileage : Number(order.startMileage) || 0;
  const end = base ? base.endMileage : Number(order.endMileage) || 0;
  const fuelLiters = base ? base.fuelLiters : Number(order.fuelLiters) || 0;
  const receivable = base ? base.receivable : Number(order.receivable) || 0;

  const lineMap = new Map<string, EffectiveLine>();
  const tollLine: EffectiveLine = {
    id: "__toll__",
    feeType: "toll",
    name: "路桥费",
    amount: base ? base.tollAmount : Number(order.tollAmount) || 0,
    ticketNo: base ? base.tollTicketNo : order.tollTicketNo,
    ticketAmount: base ? base.tollAmount : Number(order.tollAmount) || 0,
    addedAt: "base",
    lastAdjustedSeq: null
  };

  const sourceLines = base ? base.lines : order.lines;
  for (const line of sourceLines) {
    lineMap.set(line.id, {
      id: line.id,
      feeType: line.feeType,
      name: line.name,
      amount: Number(line.amount) || 0,
      ticketNo: line.ticketNo,
      ticketAmount: Number(line.ticketAmount) || 0,
      addedAt: "base",
      lastAdjustedSeq: null
    });
  }

  for (const rev of order.revisions) {
    for (const line of rev.addedLines) {
      lineMap.set(line.id, {
        id: line.id,
        feeType: line.feeType,
        name: line.name,
        amount: Number(line.amount) || 0,
        ticketNo: line.ticketNo,
        ticketAmount: Number(line.ticketAmount) || 0,
        addedAt: rev.seq,
        lastAdjustedSeq: null
      });
    }
    for (const adj of rev.adjustments) {
      const line = lineMap.get(adj.lineId);
      if (line) {
        line.amount = adj.amount;
        line.ticketNo = adj.ticketNo;
        line.ticketAmount = adj.ticketAmount;
        line.lastAdjustedSeq = rev.seq;
      }
    }
  }

  const lines = [...lineMap.values()];
  const totalExpense = round2(
    tollLine.amount + lines.reduce((sum, line) => sum + line.amount, 0)
  );

  return {
    startMileage: start,
    endMileage: end,
    actualMileage: end >= start ? end - start : start - end,
    fuelLiters,
    toll: tollLine,
    lines,
    receivable,
    totalExpense
  };
}
