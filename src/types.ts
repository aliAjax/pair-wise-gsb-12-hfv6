// 运输回单结算台 —— 领域类型定义

/** 费用项类型：同一任务下每种费用项最多报销一次 */
export type FeeType = "toll" | "fuel" | "parking" | "loading" | "other";

export const FEE_TYPE_LABELS: Record<FeeType, string> = {
  toll: "路桥费",
  fuel: "油费",
  parking: "停车费",
  loading: "装卸费",
  other: "其他费用"
};

/** 可在明细中动态添加的费用项（路桥费在顶层单列） */
export const DETAIL_FEE_TYPES: FeeType[] = ["fuel", "parking", "loading", "other"];

export type OrderStatus = "draft" | "submitted" | "confirmed";

export const STATUS_LABELS: Record<OrderStatus, string> = {
  draft: "草稿",
  submitted: "待确认",
  confirmed: "已确认"
};

export const TASK_STATUS = ["执行中", "已完成"] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];

/** 调度任务（车辆 + 司机 + 配送任务） */
export interface DispatchTask {
  id: string;
  code: string;
  vehicle: string;
  driver: string;
  zone: string;
  task: string;
  status: TaskStatus;
  createdAt: string;
}

/** 费用明细行：金额与票据票面金额分别记录，二者不一致即为冲突 */
export interface ExpenseLine {
  id: string;
  feeType: FeeType;
  name: string;
  /** 明细金额（元） */
  amount: number;
  ticketNo: string;
  /** 票据票面金额（元） */
  ticketAmount: number;
}

/** 结算确认时冻结的费用快照 */
export interface FeeSnapshot {
  startMileage: number;
  endMileage: number;
  actualMileage: number;
  fuelLiters: number;
  tollAmount: number;
  tollTicketNo: string;
  receivable: number;
  lines: ExpenseLine[];
  totalExpense: number;
  frozenAt: string;
}

/** 修订：确认后补录/调整只能生成新修订，原值保留 */
export interface Revision {
  id: string;
  seq: number;
  reason: string;
  createdAt: string;
  /** 新增的费用明细行 */
  addedLines: ExpenseLine[];
  /** 按既有行 id 调整的金额与票据，原值保留在快照/前序修订中 */
  adjustments: Array<{
    lineId: string;
    prevAmount: number;
    prevTicketNo: string;
    prevTicketAmount: number;
    amount: number;
    ticketNo: string;
    ticketAmount: number;
  }>;
}

/** 运输回单结算单 */
export interface SettlementOrder {
  id: string;
  code: string;
  taskId: string;
  status: OrderStatus;
  createdAt: string;
  submittedAt?: string;
  confirmedAt?: string;
  remark: string;

  // 每单记录：实际里程（起止表自动相减）
  startMileage: number | null;
  endMileage: number | null;
  // 油耗（升）
  fuelLiters: number | null;
  // 路桥费（元）及票据
  tollAmount: number | null;
  tollTicketNo: string;
  // 应收（元）
  receivable: number | null;

  lines: ExpenseLine[];

  /** 确认后冻结的快照，确认前为空 */
  snapshot?: FeeSnapshot;
  /** 修订链（按 seq 顺序追加，不可改） */
  revisions: Revision[];
}

/** 提交校验冲突项 */
export type ConflictCode =
  | "missing" // 必填/非负
  | "duplicate-line" // 同一单内费用项重复
  | "duplicate-task" // 同一任务同一费用项在别的单已报销
  | "duplicate-ticket" // 票据号已被使用
  | "mileage-internal" // 里程倒挂（本表内）
  | "mileage-overlap" // 里程倒挂（与同车其他回单）
  | "ticket-mismatch" // 票据金额与明细不一致
  | "ticket-missing"; // 有明细金额但缺票据号

export interface Conflict {
  code: ConflictCode;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  conflicts: Conflict[];
}

/** 结算单当前生效值（快照 + 修订链投影） */
export interface EffectiveLine {
  id: string;
  feeType: FeeType;
  name: string;
  amount: number;
  ticketNo: string;
  ticketAmount: number;
  /** 首次出现位置：base 或第 n 次修订 */
  addedAt: "base" | number;
  /** 最近一次调整所在修订序号（未调整为 null） */
  lastAdjustedSeq: number | null;
}

export interface EffectiveOrder {
  startMileage: number;
  endMileage: number;
  actualMileage: number;
  fuelLiters: number;
  toll: EffectiveLine | null;
  lines: EffectiveLine[];
  receivable: number;
  totalExpense: number;
}

export interface PersistedState {
  tasks: DispatchTask[];
  orders: SettlementOrder[];
  seqTask: number;
  seqOrder: number;
}
