import { buildLedger, projectEffective, validateOrder } from "../src/validation";
import type { DispatchTask, PersistedState, SettlementOrder } from "../src/types";
import { seedData, useSettlementStore } from "../src/store";

// Node 环境下的最小 localStorage 垫片
const mem = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  get length() {
    return mem.size;
  },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => [...mem.keys()][i] ?? null,
  removeItem: (k: string) => void mem.delete(k),
  setItem: (k: string, v: string) => void mem.set(k, v)
};

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error("FAIL:", msg);
  }
}

const data: PersistedState = seedData();
const tasks: DispatchTask[] = data.tasks;
let orders: SettlementOrder[] = data.orders;

const confirmed = orders.find((o) => o.code === "HD-2001")!;
const draft = orders.find((o) => o.code === "HD-2002")!;

// 1. 种子草稿：里程倒挂、重复油费、票明不一致 → 阻止提交
const r1 = validateOrder(draft, orders, tasks);
assert(!r1.valid, "种子草稿应校验失败");
assert(r1.conflicts.some((c) => c.code === "mileage-internal"), "应检出里程倒挂");
assert(r1.conflicts.some((c) => c.code === "duplicate-line"), "应检出重复费用项");
assert(r1.conflicts.some((c) => c.code === "ticket-mismatch"), "应检出票明不一致");
console.log("种子草稿冲突项:");
r1.conflicts.forEach((c) => console.log("  -", c.code, c.message));

// 2. 修复草稿后提交
draft.endMileage = 31200;
draft.receivable = 1800;
draft.lines = [draft.lines[0], draft.lines[2]];
draft.lines[1] = { ...draft.lines[1], ticketAmount: 60 };
// 现在 lines 只有两条: fuel 720 票 720, parking 60 票需要改
draft.lines = [
  { id: "l1", feeType: "fuel", name: "0号柴油", amount: 720, ticketNo: "YP200311", ticketAmount: 720 },
  { id: "l2", feeType: "parking", name: "园区停车", amount: 60, ticketNo: "PK300118", ticketAmount: 60 }
];
draft.tollAmount = 0;
draft.tollTicketNo = "";
const r2 = validateOrder(draft, orders, tasks);
assert(r2.valid, "修复后应通过校验，实际冲突: " + r2.conflicts.map((c) => c.message).join("; "));

// 3. 同任务重复费用项：新单给 seed-task-2 报油费，应被已确认单拦截
const dupOrder: SettlementOrder = {
  ...draft,
  id: "dup-1",
  code: "HD-2999",
  taskId: "seed-task-2",
  createdAt: new Date().toISOString(),
  tollAmount: 0,
  tollTicketNo: "",
  lines: [
    { id: "d1", feeType: "fuel", name: "再加一次油", amount: 500, ticketNo: "YP999999", ticketAmount: 500 }
  ]
};
const r3 = validateOrder(dupOrder, orders, tasks);
assert(!r3.valid, "同任务重复油费应失败");
assert(r3.conflicts.some((c) => c.code === "duplicate-task"), "应检出跨单重复报销");

// 4. 票据号重复使用
const dupTicket: SettlementOrder = {
  ...dupOrder,
  id: "dup-2",
  taskId: "seed-task-3",
  lines: [
    { id: "d2", feeType: "other", name: "杂费", amount: 100, ticketNo: "YP100221", ticketAmount: 100 }
  ]
};
const r4 = validateOrder(dupTicket, orders, tasks);
assert(r4.conflicts.some((c) => c.code === "duplicate-ticket"), "应检出票据号跨单重复");

// 5. 已确认单据：快照冻结、修订链投影
const eff0 = projectEffective(confirmed);
assert(eff0.totalExpense === 880, "含修订后费用合计应为 880 (45+800+35)");
assert(eff0.lines.find((l) => l.feeType === "parking")?.addedAt === 1, "停车费应标记为第1次修订补录");
assert(confirmed.snapshot!.totalExpense === 845, "快照原值保持 845 不变");

// 6. 补录同费用项（油费）应被修订校验拒绝
import { createPinia, setActivePinia } from "pinia";
setActivePinia(createPinia());
const store = useSettlementStore();
// 直接灌入种子数据
store.tasks = data.tasks;
store.orders = data.orders;
store.seqTask = 2000;
store.seqOrder = 3000;
const c1 = store.validateRevision(confirmed.id, {
  reason: "",
  added: [{ id: "a1", feeType: "fuel", name: "重复补油", amount: 100, ticketNo: "X1", ticketAmount: 100 }],
  adjustments: []
});
assert(c1.some((c) => c.code === "duplicate-line"), "修订补录重复油费应拒绝");
assert(c1.some((c) => c.code === "missing"), "缺修订原因应拒绝");

// 7. 合法修订：调整油费金额（原值保留）+ 补录装卸费
const c2 = store.addRevision(confirmed.id, {
  reason: "油票金额更正并补装卸费",
  added: [
    { id: "a2", feeType: "loading", name: "人工装卸", amount: 120, ticketNo: "ZX500001", ticketAmount: 120 }
  ],
  adjustments: [
    { lineId: "seed-line-1", amount: 820, ticketNo: "YP100221", ticketAmount: 820 }
  ]
});
assert(c2.length === 0, "合法修订应通过，冲突: " + c2.map((c) => c.message).join("; "));
assert(confirmed.revisions.length === 2, "应生成第2次修订");
const eff1 = projectEffective(confirmed);
assert(eff1.totalExpense === 1020, "新合计应为 45+820+35+120=1020，实际 " + eff1.totalExpense);
assert(confirmed.snapshot!.lines[0].amount === 800, "快照中油费原值 800 必须保留");
const rev2 = confirmed.revisions[1];
assert(rev2.adjustments[0].prevAmount === 800, "修订必须记录原值 800");
assert(rev2.adjustments[0].amount === 820, "修订记录新值 820");

// 8. 修订票明不一致拒绝
const c3 = store.addRevision(confirmed.id, {
  reason: "错误修订",
  added: [{ id: "a3", feeType: "other", name: "异常", amount: 50, ticketNo: "QT1", ticketAmount: 40 }],
  adjustments: []
});
assert(c3.some((c) => c.code === "ticket-mismatch"), "修订票明不一致应拒绝");
assert(confirmed.revisions.length === 2, "拒绝时不得追加修订");

// 9. 里程与同车已确认回单倒挂（同车沪B-73K9: 45200→45368）
const overlap: SettlementOrder = {
  ...dupOrder,
  id: "ov-1",
  taskId: "seed-task-2",
  status: "draft",
  startMileage: 45000,
  endMileage: 45100,
  tollAmount: 0,
  tollTicketNo: "",
  lines: [{ id: "o1", feeType: "other", name: "x", amount: 10, ticketNo: "OV1", ticketAmount: 10 }]
};
const r9 = validateOrder(overlap, orders, tasks);
assert(r9.conflicts.some((c) => c.code === "mileage-overlap"), "应检出同车里程倒挂");

// 10. ledger 只统计已确认单
const ledger = buildLedger(orders);
assert(ledger.taskFee.has("seed-task-2::fuel"), "台账包含已确认油费");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
