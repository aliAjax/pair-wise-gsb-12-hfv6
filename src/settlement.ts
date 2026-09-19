/* 运输回单结算台：领域模型与校验规则（纯函数，便于核对与测试） */

export type ExpenseKind = "fuel" | "toll" | "other";

export const KIND_LABELS: Record<ExpenseKind, string> = {
  fuel: "油费",
  toll: "路桥费",
  other: "其他费用",
};

export const KIND_ORDER: ExpenseKind[] = ["fuel", "toll", "other"];

export interface ReceiptLine {
  id: string;
  kind: ExpenseKind;
  invoiceNo: string;
  amount: number;
}

/** 结算确认后会被冻结进快照的费用字段 */
export interface DraftFields {
  startOdometer: number;
  endOdometer: number;
  fuelLiters: number;
  fuelPrice: number;
  tollFee: number;
  otherFee: number;
  receivable: number;
  receipts: ReceiptLine[];
}

/** 冻结快照：一次结算确认 / 一次补录修订的完整留痕 */
export interface Snapshot {
  startOdometer: number;
  endOdometer: number;
  actualMileage: number;
  fuelLiters: number;
  fuelPrice: number;
  fuelFee: number;
  tollFee: number;
  otherFee: number;
  receivable: number;
  expenseTotal: number;
  receipts: ReceiptLine[];
  receiptTotal: number;
}

export interface Revision {
  revisionNo: number;
  createdAt: string;
  reason: string;
  snapshot: Snapshot;
}

export interface Settlement extends DraftFields {
  id: string;
  taskNo: string;
  vehicle: string;
  driver: string;
  zone: string;
  status: "draft" | "settled";
  createdAt: string;
  settledAt: string | null;
  revisions: Revision[];
}

export interface DraftInput extends DraftFields {
  taskNo: string;
}

export interface Conflict {
  type: string;
  message: string;
}

const EPS = 0.005;

export const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export const money = (n: number): string => `¥${round2(n).toFixed(2)}`;

export const sameMoney = (a: number, b: number): boolean => Math.abs(a - b) <= EPS;

export const uid = (): string => crypto.randomUUID();

export function detailOf(kind: ExpenseKind, s: { fuelFee: number; tollFee: number; otherFee: number }): number {
  if (kind === "fuel") return s.fuelFee;
  if (kind === "toll") return s.tollFee;
  return s.otherFee;
}

export function receiptSum(receipts: ReceiptLine[], kind: ExpenseKind): number {
  return round2(receipts.filter((r) => r.kind === kind).reduce((acc, r) => acc + num(r.amount), 0));
}

/** 由表单/草稿字段生成一份冻结快照（深拷贝票据，外部后续修改不影响快照） */
export function buildSnapshot(input: DraftFields): Snapshot {
  const startOdometer = num(input.startOdometer);
  const endOdometer = num(input.endOdometer);
  const fuelLiters = num(input.fuelLiters);
  const fuelPrice = num(input.fuelPrice);
  const fuelFee = round2(fuelLiters * fuelPrice);
  const tollFee = round2(num(input.tollFee));
  const otherFee = round2(num(input.otherFee));
  const receipts = input.receipts.map((r) => ({ ...r, amount: round2(num(r.amount)) }));
  return {
    startOdometer,
    endOdometer,
    actualMileage: round2(endOdometer - startOdometer),
    fuelLiters,
    fuelPrice,
    fuelFee,
    tollFee,
    otherFee,
    receivable: round2(num(input.receivable)),
    expenseTotal: round2(fuelFee + tollFee + otherFee),
    receipts,
    receiptTotal: round2(receipts.reduce((acc, r) => acc + r.amount, 0)),
  };
}

/** 当前口径：已结算取最新修订快照，草稿取自身字段 */
export function currentSnapshot(s: Settlement): Snapshot {
  return s.revisions.length > 0 ? s.revisions[s.revisions.length - 1].snapshot : buildSnapshot(s);
}

/** 全量票据（含历史修订），用于票号全局唯一性核对 */
export function allReceipts(list: Settlement[], excludeId?: string): ReceiptLine[] {
  const out: ReceiptLine[] = [];
  for (const s of list) {
    if (s.id === excludeId) continue;
    if (s.revisions.length > 0) {
      for (const rev of s.revisions) out.push(...rev.snapshot.receipts);
    } else {
      out.push(...s.receipts);
    }
  }
  return out;
}

/**
 * 提交/结算确认校验：任一冲突都阻止提交。
 * 规则：里程倒挂、数值异常、票据行无效、同任务同费用项重复报销、
 * 票号重复、票据金额与费用明细不一致（按费用项双向核对）。
 */
export function validateSettlement(input: DraftInput, existing: Settlement[], excludeId?: string): Conflict[] {
  const conflicts: Conflict[] = [];
  const start = num(input.startOdometer);
  const end = num(input.endOdometer);

  if (end < start) {
    conflicts.push({
      type: "里程倒挂",
      message: `结束表显 ${end}km 小于起始表显 ${start}km，里程倒挂 ${round2(start - end)}km`,
    });
  }

  if (num(input.fuelLiters) < 0 || num(input.fuelPrice) < 0) {
    conflicts.push({ type: "数值异常", message: "油耗与油价不得为负数" });
  }
  if (num(input.tollFee) < 0 || num(input.otherFee) < 0) {
    conflicts.push({ type: "数值异常", message: "路桥费与其他费用不得为负数" });
  }
  if (num(input.receivable) <= 0) {
    conflicts.push({ type: "数值异常", message: "应收金额必须大于 0" });
  }

  const rows = input.receipts;
  rows.forEach((row, i) => {
    if (!row.invoiceNo.trim()) {
      conflicts.push({ type: "票据无效", message: `第 ${i + 1} 行票据缺少票号` });
    }
    if (num(row.amount) <= 0) {
      conflicts.push({ type: "票据无效", message: `第 ${i + 1} 行票据（${KIND_LABELS[row.kind]}）金额必须大于 0` });
    }
  });

  // 同一任务同一费用项不得重复报销：单内自查
  const kindCount = new Map<ExpenseKind, number>();
  for (const row of rows) kindCount.set(row.kind, (kindCount.get(row.kind) ?? 0) + 1);
  for (const [kind, count] of kindCount) {
    if (count > 1) {
      conflicts.push({
        type: "重复报销",
        message: `同一任务同一费用项不得重复报销：${KIND_LABELS[kind]}在本单出现 ${count} 次`,
      });
    }
  }

  // 同一任务同一费用项不得重复报销：跨结算单核对（以各单最新修订为准）
  const taskNo = input.taskNo.trim();
  const formKinds = new Set(rows.map((r) => r.kind));
  for (const other of existing) {
    if (other.id === excludeId || other.taskNo.trim() !== taskNo) continue;
    const otherKinds = new Set(currentSnapshot(other).receipts.map((r) => r.kind));
    for (const kind of KIND_ORDER) {
      if (formKinds.has(kind) && otherKinds.has(kind)) {
        conflicts.push({
          type: "重复报销",
          message: `任务 ${taskNo} 的${KIND_LABELS[kind]}已在结算单 ${other.id.slice(0, 8)}（${other.vehicle}/${other.driver}）报销，不得重复`,
        });
      }
    }
  }

  // 票号全局唯一
  const seenInv = new Set<string>();
  const usedInv = new Set(allReceipts(existing, excludeId).map((r) => r.invoiceNo));
  rows.forEach((row, i) => {
    const inv = row.invoiceNo.trim();
    if (!inv) return;
    if (seenInv.has(inv)) {
      conflicts.push({ type: "票号重复", message: `票号 ${inv} 在本单重复出现（第 ${i + 1} 行）` });
    } else if (usedInv.has(inv)) {
      conflicts.push({ type: "票号重复", message: `票号 ${inv} 已存在于其他结算单，不得重复报销` });
    }
    seenInv.add(inv);
  });

  // 票据金额与明细不一致：按费用项双向核对（有明细无票据 / 有票据无明细 / 金额不符都算冲突）
  const snap = buildSnapshot(input);
  for (const kind of KIND_ORDER) {
    const detail = detailOf(kind, snap);
    const sum = receiptSum(rows, kind);
    if (!sameMoney(detail, sum)) {
      conflicts.push({
        type: "票据与明细不一致",
        message: `${KIND_LABELS[kind]}：票据合计 ${money(sum)} 与费用明细 ${money(detail)} 不一致，差额 ${money(detail - sum)}`,
      });
    }
  }

  return conflicts;
}

/**
 * 补录票据校验：只允许生成新修订，费用项不得重复报销、票号不得重复。
 */
export function validateSupplement(
  target: Settlement,
  receipt: Pick<ReceiptLine, "kind" | "invoiceNo" | "amount">,
  all: Settlement[],
): Conflict[] {
  const conflicts: Conflict[] = [];
  const inv = receipt.invoiceNo.trim();

  if (num(receipt.amount) <= 0) {
    conflicts.push({ type: "票据无效", message: "补录票据金额必须大于 0" });
  }
  if (!inv) {
    conflicts.push({ type: "票据无效", message: "补录票据缺少票号" });
  }

  if (currentSnapshot(target).receipts.some((r) => r.kind === receipt.kind)) {
    conflicts.push({
      type: "重复报销",
      message: `任务 ${target.taskNo} 的${KIND_LABELS[receipt.kind]}已报销（见最新修订），同一费用项不得重复报销`,
    });
  }
  for (const other of all) {
    if (other.id === target.id || other.taskNo.trim() !== target.taskNo.trim()) continue;
    if (currentSnapshot(other).receipts.some((r) => r.kind === receipt.kind)) {
      conflicts.push({
        type: "重复报销",
        message: `任务 ${target.taskNo} 的${KIND_LABELS[receipt.kind]}已在结算单 ${other.id.slice(0, 8)}（${other.vehicle}/${other.driver}）报销，不得重复`,
      });
    }
  }

  if (inv && allReceipts(all).some((r) => r.invoiceNo === inv)) {
    conflicts.push({ type: "票号重复", message: `票号 ${inv} 已存在，不得重复录入` });
  }

  return conflicts;
}

/** 初始演示数据：一单已结算且含补录修订链，一单待结算 */
export function seedSettlements(): Settlement[] {
  const s1: Settlement = {
    id: uid(),
    taskNo: "RW20260912-001",
    vehicle: "沪A-82L6",
    driver: "董飞",
    zone: "城北",
    status: "settled",
    createdAt: "2026-09-12T08:20:00.000Z",
    settledAt: "2026-09-12T19:05:00.000Z",
    startOdometer: 12540,
    endOdometer: 12890,
    fuelLiters: 42,
    fuelPrice: 7.8,
    tollFee: 180,
    otherFee: 0,
    receivable: 1500,
    receipts: [
      { id: uid(), kind: "fuel", invoiceNo: "FP-2026-1001", amount: 327.6 },
      { id: uid(), kind: "toll", invoiceNo: "FP-2026-1002", amount: 180 },
    ],
    revisions: [],
  };
  const r1: Revision = {
    revisionNo: 1,
    createdAt: "2026-09-12T19:05:00.000Z",
    reason: "结算确认，费用快照冻结",
    snapshot: buildSnapshot(s1),
  };
  const r2Receipts = [
    ...r1.snapshot.receipts.map((r) => ({ ...r })),
    { id: uid(), kind: "other" as ExpenseKind, invoiceNo: "FP-2026-1017", amount: 65 },
  ];
  const r2: Revision = {
    revisionNo: 2,
    createdAt: "2026-09-14T10:32:00.000Z",
    reason: "补录票据 FP-2026-1017：服务区停车费",
    snapshot: {
      ...r1.snapshot,
      receipts: r2Receipts,
      receiptTotal: round2(r2Receipts.reduce((acc, r) => acc + r.amount, 0)),
    },
  };
  s1.revisions = [r1, r2];

  const s2: Settlement = {
    id: uid(),
    taskNo: "RW20260915-002",
    vehicle: "沪B-73K9",
    driver: "周航",
    zone: "城东",
    status: "draft",
    createdAt: "2026-09-15T09:10:00.000Z",
    settledAt: null,
    startOdometer: 8820,
    endOdometer: 9055,
    fuelLiters: 28,
    fuelPrice: 7.8,
    tollFee: 95,
    otherFee: 0,
    receivable: 980,
    receipts: [
      { id: uid(), kind: "fuel", invoiceNo: "FP-2026-1031", amount: 218.4 },
      { id: uid(), kind: "toll", invoiceNo: "FP-2026-1032", amount: 95 },
    ],
    revisions: [],
  };

  return [s2, s1];
}
