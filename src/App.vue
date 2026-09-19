<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import {
  KIND_LABELS,
  KIND_ORDER,
  buildSnapshot,
  currentSnapshot,
  money,
  num,
  round2,
  seedSettlements,
  uid,
  validateSettlement,
  validateSupplement,
} from "./settlement";
import type { Conflict, ExpenseKind, ReceiptLine, Settlement, Snapshot } from "./settlement";

const project = {
  "number": 3,
  "folder": "dfwl/frontend/dfwlfront-3",
  "framework": "vue",
  "title": "运输回单结算台",
  "subtitle": "每单记录实际里程、油耗、路桥费与应收；里程倒挂、同任务同费用项重复报销、票据与明细不一致一律阻止提交并列出冲突项；结算确认后费用快照冻结，补录票据只生成新修订并保留原值。",
  "industry": "物流",
  "stack": [
    "Vue3",
    "Vite",
    "TypeScript",
    "Pinia",
    "Naive UI"
  ],
  "storageKey": "dfwlfront-3-settlement",
  "formTitle": "新建结算单",
  "primaryAction": "提交结算单",
  "entityLabel": "结算单",
  "zones": [
    "城北",
    "城东",
    "城南"
  ],
  "statusFilters": [
    "全部状态",
    "待结算",
    "已结算"
  ],
  "metricLabels": [
    "结算单总数",
    "待结算",
    "已结算",
    "已结算应收"
  ]
} as const;

/* ---------------- 持久化：刷新后结算、票据、修订链全部保留 ---------------- */

function load(): Settlement[] {
  try {
    const raw = localStorage.getItem(project.storageKey);
    if (!raw) return seedSettlements();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return seedSettlements();
    return parsed as Settlement[];
  } catch {
    return seedSettlements();
  }
}

const settlements = ref<Settlement[]>(load());

function persist() {
  localStorage.setItem(project.storageKey, JSON.stringify(settlements.value));
}

/* ---------------- 新建结算单表单 ---------------- */

const blankForm = () => ({
  taskNo: "",
  vehicle: "",
  driver: "",
  zone: "",
  startOdometer: 0,
  endOdometer: 0,
  fuelLiters: 0,
  fuelPrice: 7.8,
  tollFee: 0,
  otherFee: 0,
  receivable: 0,
});

const blankRows = (): ReceiptLine[] => [
  { id: uid(), kind: "fuel", invoiceNo: "", amount: 0 },
  { id: uid(), kind: "toll", invoiceNo: "", amount: 0 },
];

const form = reactive(blankForm());
const receiptRows = ref<ReceiptLine[]>(blankRows());
const formConflicts = ref<Conflict[]>([]);

const formSnapshot = computed<Snapshot>(() => buildSnapshot({ ...form, receipts: receiptRows.value }));
const formDiff = computed(() => round2(formSnapshot.value.receiptTotal - formSnapshot.value.expenseTotal));

function addRow() {
  receiptRows.value.push({ id: uid(), kind: "other", invoiceNo: "", amount: 0 });
}

function removeRow(index: number) {
  receiptRows.value.splice(index, 1);
}

/** 按费用明细一键生成对应票据行，票号留空待填 */
function fillReceiptsFromDetails() {
  const snap = buildSnapshot({ ...form, receipts: [] });
  const rows: ReceiptLine[] = [];
  for (const kind of KIND_ORDER) {
    const detail = kind === "fuel" ? snap.fuelFee : kind === "toll" ? snap.tollFee : snap.otherFee;
    if (detail > 0) rows.push({ id: uid(), kind, invoiceNo: "", amount: detail });
  }
  receiptRows.value = rows.length > 0 ? rows : blankRows();
}

function submit() {
  const conflicts = validateSettlement({ ...form, receipts: receiptRows.value }, settlements.value);
  formConflicts.value = conflicts;
  if (conflicts.length > 0) return;
  const settlement: Settlement = {
    id: uid(),
    taskNo: form.taskNo.trim(),
    vehicle: form.vehicle.trim(),
    driver: form.driver.trim(),
    zone: form.zone,
    status: "draft",
    createdAt: new Date().toISOString(),
    settledAt: null,
    startOdometer: num(form.startOdometer),
    endOdometer: num(form.endOdometer),
    fuelLiters: num(form.fuelLiters),
    fuelPrice: num(form.fuelPrice),
    tollFee: round2(num(form.tollFee)),
    otherFee: round2(num(form.otherFee)),
    receivable: round2(num(form.receivable)),
    receipts: receiptRows.value.map((r) => ({
      ...r,
      id: uid(),
      invoiceNo: r.invoiceNo.trim(),
      amount: round2(num(r.amount)),
    })),
    revisions: [],
  };
  settlements.value = [settlement, ...settlements.value];
  Object.assign(form, blankForm());
  receiptRows.value = blankRows();
  persist();
}

/* ---------------- 结算确认：冻结快照为 R1 ---------------- */

const cardConflicts = reactive<Record<string, Conflict[]>>({});

function confirmSettlement(s: Settlement) {
  // 确认时按最新数据复检，防止同任务其他单据在此期间抢报了同一费用项
  const conflicts = validateSettlement(s, settlements.value, s.id);
  cardConflicts[s.id] = conflicts;
  if (conflicts.length > 0) return;
  s.status = "settled";
  s.settledAt = new Date().toISOString();
  s.revisions = [
    {
      revisionNo: 1,
      createdAt: s.settledAt,
      reason: "结算确认，费用快照冻结",
      snapshot: buildSnapshot(s),
    },
  ];
  persist();
}

/* ---------------- 补录票据：只生成新修订，原值保留 ---------------- */

const supplementFor = ref<string | null>(null);
const supp = reactive<{ kind: ExpenseKind; invoiceNo: string; amount: number; note: string }>({
  kind: "other",
  invoiceNo: "",
  amount: 0,
  note: "",
});

function availableKinds(s: Settlement): ExpenseKind[] {
  const used = new Set(currentSnapshot(s).receipts.map((r) => r.kind));
  return KIND_ORDER.filter((k) => !used.has(k));
}

function openSupplement(s: Settlement) {
  supplementFor.value = s.id;
  Object.assign(supp, {
    kind: availableKinds(s)[0] ?? "other",
    invoiceNo: "",
    amount: 0,
    note: "",
  });
  cardConflicts[s.id] = [];
}

function submitSupplement(s: Settlement) {
  const receipt: ReceiptLine = {
    id: uid(),
    kind: supp.kind,
    invoiceNo: supp.invoiceNo.trim(),
    amount: round2(num(supp.amount)),
  };
  const conflicts = validateSupplement(s, receipt, settlements.value);
  cardConflicts[s.id] = conflicts;
  if (conflicts.length > 0) return;
  const prev = currentSnapshot(s);
  const snapshot: Snapshot = {
    ...prev,
    receipts: [...prev.receipts.map((r) => ({ ...r })), receipt],
    receiptTotal: round2(prev.receiptTotal + receipt.amount),
  };
  s.revisions.push({
    revisionNo: s.revisions.length + 1,
    createdAt: new Date().toISOString(),
    reason: `补录票据 ${receipt.invoiceNo}${supp.note.trim() ? `：${supp.note.trim()}` : ""}`,
    snapshot,
  });
  supplementFor.value = null;
  expanded[s.id] = true;
  persist();
}

/* ---------------- 列表、筛选、指标 ---------------- */

const statusFilter = ref<string>(project.statusFilters[0]);

const filtered = computed(() => {
  const list = [...settlements.value].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (statusFilter.value === "待结算") return list.filter((s) => s.status === "draft");
  if (statusFilter.value === "已结算") return list.filter((s) => s.status === "settled");
  return list;
});

const metrics = computed<(number | string)[]>(() => {
  const total = settlements.value.length;
  const draft = settlements.value.filter((s) => s.status === "draft").length;
  const settled = settlements.value.filter((s) => s.status === "settled").length;
  const receivable = settlements.value
    .filter((s) => s.status === "settled")
    .reduce((acc, s) => acc + currentSnapshot(s).receivable, 0);
  return [total, draft, settled, money(receivable)];
});

const chartRows = computed(() => {
  const snaps = settlements.value.map((s) => currentSnapshot(s));
  return [
    { label: "油费", value: round2(snaps.reduce((a, s) => a + s.fuelFee, 0)) },
    { label: "路桥费", value: round2(snaps.reduce((a, s) => a + s.tollFee, 0)) },
    { label: "其他费用", value: round2(snaps.reduce((a, s) => a + s.otherFee, 0)) },
    { label: "应收", value: round2(snaps.reduce((a, s) => a + s.receivable, 0)) },
  ];
});

const maxChart = computed(() => Math.max(1, ...chartRows.value.map((row) => row.value)));

/* ---------------- 展示辅助 ---------------- */

const expanded = reactive<Record<string, boolean>>({});
const snap = currentSnapshot;

const statusLabel = (s: Settlement) => (s.status === "settled" ? "已结算" : "待结算");
const snapshotDiff = (s: Snapshot) => round2(s.receiptTotal - s.expenseTotal);
const fmtTime = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false });

function toggleRevisions(id: string) {
  expanded[id] = !expanded[id];
}

function copySummary(s: Settlement) {
  const c = currentSnapshot(s);
  const text = `任务${s.taskNo} ${s.vehicle}/${s.driver} 里程${c.actualMileage}km 油费${money(c.fuelFee)} 路桥${money(c.tollFee)} 其他${money(c.otherFee)} 应收${money(c.receivable)} 票据合计${money(c.receiptTotal)} ${statusLabel(s)}`;
  navigator.clipboard?.writeText(text);
}

function remove(id: string) {
  // 已结算单已冻结，不允许删除，保证修订链可核对
  settlements.value = settlements.value.filter((s) => s.id !== id || s.status === "settled");
  persist();
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">{{ project.industry }}行业前端最小闭环</p>
          <h1>{{ project.title }}</h1>
          <p class="subtitle">{{ project.subtitle }}</p>
        </div>
        <div class="stack">
          <span v-for="item in project.stack" :key="item" class="tag">{{ item }}</span>
        </div>
      </header>

      <section class="metrics">
        <article v-for="(label, index) in project.metricLabels" :key="label" class="metric">
          <span>{{ label }}</span>
          <strong>{{ metrics[index] }}</strong>
        </article>
      </section>

      <section class="workspace">
        <form class="panel" @submit.prevent="submit">
          <h2>{{ project.formTitle }}</h2>
          <div class="form-grid">
            <label>
              任务号
              <input v-model.trim="form.taskNo" required placeholder="如 RW20260919-003" />
            </label>
            <div class="field-pair">
              <label>
                车牌号
                <input v-model.trim="form.vehicle" required placeholder="如 沪C-56D8" />
              </label>
              <label>
                司机
                <input v-model.trim="form.driver" required placeholder="司机姓名" />
              </label>
            </div>
            <label>
              配送区域
              <select v-model="form.zone" required>
                <option value="">请选择</option>
                <option v-for="z in project.zones" :key="z">{{ z }}</option>
              </select>
            </label>
            <div class="field-pair">
              <label>
                起始表显(km)
                <input v-model.number="form.startOdometer" type="number" min="0" step="0.1" required />
              </label>
              <label>
                结束表显(km)
                <input v-model.number="form.endOdometer" type="number" min="0" step="0.1" required />
              </label>
            </div>
            <p class="hint" :class="{ bad: formSnapshot.actualMileage < 0 }">
              实际里程：{{ formSnapshot.actualMileage }} km
              <span v-if="formSnapshot.actualMileage < 0">（里程倒挂，无法提交）</span>
            </p>
            <div class="field-pair">
              <label>
                油耗(L)
                <input v-model.number="form.fuelLiters" type="number" min="0" step="0.1" required />
              </label>
              <label>
                油价(元/L)
                <input v-model.number="form.fuelPrice" type="number" min="0" step="0.01" required />
              </label>
            </div>
            <div class="field-pair">
              <label>
                路桥费(元)
                <input v-model.number="form.tollFee" type="number" min="0" step="0.01" required />
              </label>
              <label>
                其他费用(元)
                <input v-model.number="form.otherFee" type="number" min="0" step="0.01" required />
              </label>
            </div>
            <label>
              应收(元)
              <input v-model.number="form.receivable" type="number" min="0" step="0.01" required />
            </label>

            <fieldset class="receipt-editor">
              <legend>票据明细（票号唯一，同一费用项仅可一张）</legend>
              <div v-for="(row, i) in receiptRows" :key="row.id" class="receipt-row">
                <select v-model="row.kind">
                  <option v-for="k in KIND_ORDER" :key="k" :value="k">{{ KIND_LABELS[k] }}</option>
                </select>
                <input v-model.trim="row.invoiceNo" placeholder="票号，如 FP-2026-0001" />
                <input v-model.number="row.amount" type="number" min="0" step="0.01" placeholder="金额" />
                <button type="button" class="secondary" :disabled="receiptRows.length <= 1" @click="removeRow(i)">删</button>
              </div>
              <div class="receipt-tools">
                <button type="button" class="secondary" @click="addRow">+ 添加票据行</button>
                <button type="button" class="secondary" @click="fillReceiptsFromDetails">按费用明细填充</button>
              </div>
            </fieldset>

            <div class="summary-bar">
              <span>费用合计 <strong>{{ money(formSnapshot.expenseTotal) }}</strong></span>
              <span>票据合计 <strong>{{ money(formSnapshot.receiptTotal) }}</strong></span>
              <span :class="{ bad: formDiff !== 0 }">差额 <strong>{{ money(formDiff) }}</strong></span>
            </div>

            <div v-if="formConflicts.length > 0" class="conflicts">
              <strong>提交被阻止：{{ formConflicts.length }} 项冲突</strong>
              <ul>
                <li v-for="(c, i) in formConflicts" :key="i"><b>[{{ c.type }}]</b> {{ c.message }}</li>
              </ul>
            </div>

            <button type="submit">{{ project.primaryAction }}</button>
          </div>
        </form>

        <section class="list-panel">
          <div class="toolbar">
            <h2>{{ project.entityLabel }}列表</h2>
            <select v-model="statusFilter">
              <option v-for="item in project.statusFilters" :key="item">{{ item }}</option>
            </select>
          </div>

          <div class="record-grid">
            <div v-if="filtered.length === 0" class="empty">暂无匹配数据</div>
            <article v-for="s in filtered" :key="s.id" class="record">
              <div class="record-head">
                <p class="record-title">{{ s.taskNo }} · {{ s.vehicle }} / {{ s.driver }}</p>
                <div class="badges">
                  <span v-if="s.revisions.length > 0" class="badge rev">R{{ s.revisions[s.revisions.length - 1].revisionNo }}</span>
                  <span class="status" :class="{ pending: s.status === 'draft' }">{{ statusLabel(s) }}</span>
                </div>
              </div>
              <p class="meta">区域 {{ s.zone }} · 创建 {{ fmtTime(s.createdAt) }} · 结算 {{ s.settledAt ? fmtTime(s.settledAt) : "—" }}</p>
              <div class="details">
                <span>实际里程: {{ snap(s).actualMileage }} km（表显 {{ snap(s).startOdometer }}→{{ snap(s).endOdometer }}）</span>
                <span>油耗: {{ snap(s).fuelLiters }} L × ¥{{ snap(s).fuelPrice }}/L</span>
                <span>油费: {{ money(snap(s).fuelFee) }}</span>
                <span>路桥费: {{ money(snap(s).tollFee) }}</span>
                <span>其他费用: {{ money(snap(s).otherFee) }}</span>
                <span>费用合计: {{ money(snap(s).expenseTotal) }}</span>
                <span>应收: {{ money(snap(s).receivable) }}</span>
                <span>票据合计: {{ money(snap(s).receiptTotal) }}</span>
              </div>
              <p v-if="snapshotDiff(snap(s)) !== 0" class="diff-warn">
                票据合计与费用明细差额 {{ money(snapshotDiff(snap(s))) }}（补录挂账，见修订链）
              </p>

              <p class="table-caption">票据明细（{{ s.revisions.length > 0 ? `R${s.revisions[s.revisions.length - 1].revisionNo} 快照` : "未冻结" }}）</p>
              <table class="receipt-table">
                <thead>
                  <tr><th>费用项</th><th>票号</th><th>金额</th></tr>
                </thead>
                <tbody>
                  <tr v-for="r in snap(s).receipts" :key="r.id">
                    <td>{{ KIND_LABELS[r.kind] }}</td>
                    <td>{{ r.invoiceNo }}</td>
                    <td>{{ money(r.amount) }}</td>
                  </tr>
                </tbody>
              </table>

              <div v-if="cardConflicts[s.id]?.length" class="conflicts">
                <strong>操作被阻止：{{ cardConflicts[s.id].length }} 项冲突</strong>
                <ul>
                  <li v-for="(c, i) in cardConflicts[s.id]" :key="i"><b>[{{ c.type }}]</b> {{ c.message }}</li>
                </ul>
              </div>

              <div class="actions">
                <template v-if="s.status === 'draft'">
                  <button type="button" @click="confirmSettlement(s)">结算确认（冻结快照）</button>
                  <button class="secondary" type="button" @click="copySummary(s)">复制摘要</button>
                  <button class="danger" type="button" @click="remove(s.id)">删除</button>
                </template>
                <template v-else>
                  <button
                    type="button"
                    :disabled="availableKinds(s).length === 0"
                    :title="availableKinds(s).length === 0 ? '全部费用项均已报销' : '补录票据将生成新修订，原值保留'"
                    @click="openSupplement(s)"
                  >补录票据</button>
                  <button class="secondary" type="button" @click="toggleRevisions(s.id)">
                    {{ expanded[s.id] ? "收起修订链" : `修订链（${s.revisions.length}）` }}
                  </button>
                  <button class="secondary" type="button" @click="copySummary(s)">复制摘要</button>
                </template>
              </div>

              <div v-if="supplementFor === s.id" class="supp-form">
                <h3>补录票据（生成新修订，原值保留）</h3>
                <div class="receipt-row">
                  <select v-model="supp.kind">
                    <option v-for="k in availableKinds(s)" :key="k" :value="k">{{ KIND_LABELS[k] }}</option>
                  </select>
                  <input v-model.trim="supp.invoiceNo" placeholder="票号" />
                  <input v-model.number="supp.amount" type="number" min="0" step="0.01" placeholder="金额" />
                </div>
                <input v-model.trim="supp.note" placeholder="补录说明（可选），如：服务区停车费" />
                <div class="actions">
                  <button type="button" @click="submitSupplement(s)">生成新修订</button>
                  <button class="secondary" type="button" @click="supplementFor = null">取消</button>
                </div>
              </div>

              <div v-if="expanded[s.id] && s.revisions.length > 0" class="revisions">
                <h3>修订链（原值保留，最新修订为当前口径）</h3>
                <div v-for="rev in [...s.revisions].reverse()" :key="rev.revisionNo" class="revision">
                  <div class="revision-head">
                    <strong>R{{ rev.revisionNo }}</strong>
                    <span v-if="rev.revisionNo === 1" class="badge origin">原值</span>
                    <span v-if="rev.revisionNo === s.revisions.length" class="badge current">当前</span>
                    <span>{{ rev.reason }}</span>
                    <time>{{ fmtTime(rev.createdAt) }}</time>
                  </div>
                  <div class="revision-body">
                    <span>里程 {{ rev.snapshot.actualMileage }} km（冻结）</span>
                    <span>费用合计 {{ money(rev.snapshot.expenseTotal) }}（冻结）</span>
                    <span>应收 {{ money(rev.snapshot.receivable) }}（冻结）</span>
                    <span>票据合计 {{ money(rev.snapshot.receiptTotal) }}</span>
                  </div>
                  <table class="receipt-table">
                    <thead>
                      <tr><th>费用项</th><th>票号</th><th>金额</th></tr>
                    </thead>
                    <tbody>
                      <tr v-for="r in rev.snapshot.receipts" :key="r.id">
                        <td>{{ KIND_LABELS[r.kind] }}</td>
                        <td>{{ r.invoiceNo }}</td>
                        <td>{{ money(r.amount) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </article>
          </div>

          <div class="mini-chart">
            <div v-for="row in chartRows" :key="row.label" class="bar">
              <span>{{ row.label }}</span>
              <div class="bar-track"><div class="bar-fill" :style="{ width: `${(row.value / maxChart) * 100}%` }" /></div>
              <strong>{{ money(row.value) }}</strong>
            </div>
          </div>
        </section>
      </section>
    </div>
  </main>
</template>
