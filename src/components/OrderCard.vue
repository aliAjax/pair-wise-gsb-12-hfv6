<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import type { DispatchTask, ExpenseLine, FeeType, SettlementOrder } from "../types";
import { DETAIL_FEE_TYPES, FEE_TYPE_LABELS, STATUS_LABELS } from "../types";
import { lineLabel, projectEffective, round2 } from "../validation";
import { useSettlementStore } from "../store";
import ConflictBox from "./ConflictBox.vue";
import RevisionDialog from "./RevisionDialog.vue";

const props = defineProps<{ order: SettlementOrder; task: DispatchTask }>();

const store = useSettlementStore();
const conflicts = ref<ReturnType<typeof store.submitOrder>>([]);
const showRevision = ref(false);

// 确认后展示的视图：snapshot（冻结原值）/ effective（含修订现值）
const viewMode = ref<"snapshot" | "effective">("effective");

const eff = computed(() => projectEffective(props.order));
const frozen = computed(() => props.order.snapshot);
const isConfirmed = computed(() => props.order.status === "confirmed");

// 仅草稿/待确认可编辑
const editable = computed(() => !isConfirmed.value);

const mileageInverted = computed(() => {
  const s = Number(props.order.startMileage);
  const e = Number(props.order.endMileage);
  return (
    props.order.startMileage !== null &&
    props.order.endMileage !== null &&
    !Number.isNaN(s) &&
    !Number.isNaN(e) &&
    e < s
  );
});

const actualMileage = computed(() => {
  if (props.order.startMileage === null || props.order.endMileage === null) return null;
  const s = Number(props.order.startMileage);
  const e = Number(props.order.endMileage);
  return e - s;
});

// 单内费用项重复（含顶层路桥费）
const duplicateTypes = computed(() => {
  const counter = new Map<FeeType, number>();
  if ((Number(props.order.tollAmount) || 0) > 0) counter.set("toll", 1);
  for (const line of props.order.lines) {
    if ((Number(line.amount) || 0) > 0 || line.ticketNo.trim()) {
      counter.set(line.feeType, (counter.get(line.feeType) ?? 0) + 1);
    }
  }
  return new Set([...counter].filter(([, n]) => n > 1).map(([t]) => t));
});

const ticketMismatch = (line: ExpenseLine) =>
  (Number(line.amount) || 0) > 0 &&
  round2(Number(line.ticketAmount) || 0) !== round2(Number(line.amount) || 0);

function patch(p: Partial<SettlementOrder>) {
  store.updateOrder(props.order.id, p);
}
function patchLine(line: ExpenseLine, p: Partial<ExpenseLine>) {
  store.updateDraftLine(props.order.id, line.id, p);
}

function submit() {
  conflicts.value = store.submitOrder(props.order.id);
}
function confirmSettlement() {
  conflicts.value = store.confirmOrder(props.order.id);
}
function backToDraft() {
  store.updateOrder(props.order.id, { status: "draft" });
}

function fmtTime(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}
function money(n: number) {
  return `${round2(n).toFixed(2)} 元`;
}

// —— 确认后视图：顶层路桥费与明细行合并展示 ——
const viewToll = computed(() => (viewMode.value === "snapshot" ? frozen.value!.tollAmount : eff.value.toll?.amount ?? 0));
const viewLines = computed(() =>
  viewMode.value === "snapshot"
    ? frozen.value!.lines.map((l) => ({ line: l, meta: { addedAt: "base" as const, lastAdjustedSeq: null as number | null } }))
    : eff.value.lines.map((l) => ({
        line: { id: l.id, feeType: l.feeType, name: l.name, amount: l.amount, ticketNo: l.ticketNo, ticketAmount: l.ticketAmount } as ExpenseLine,
        meta: { addedAt: l.addedAt, lastAdjustedSeq: l.lastAdjustedSeq }
      }))
);
const viewTotals = computed(() => {
  if (viewMode.value === "snapshot") {
    const s = frozen.value!;
    return {
      mileage: s.actualMileage,
      fuel: s.fuelLiters,
      expense: s.totalExpense,
      receivable: s.receivable
    };
  }
  return {
    mileage: eff.value.actualMileage,
    fuel: eff.value.fuelLiters,
    expense: eff.value.totalExpense,
    receivable: eff.value.receivable
  };
});

watch(
  () => props.order.id,
  () => {
    conflicts.value = [];
    viewMode.value = "effective";
  }
);

const lineTypeOptions = computed(() =>
  DETAIL_FEE_TYPES.map((t) => ({ value: t, label: FEE_TYPE_LABELS[t] }))
);
</script>

<template>
  <article class="order-card" :class="{ 'is-confirmed': isConfirmed }">
    <div class="order-head">
      <div>
        <p class="order-title">
          {{ order.code }}
          <span class="task-name">{{ task.vehicle }} · {{ task.driver }} · {{ task.task }}（{{ task.zone }}）</span>
        </p>
        <p class="order-time">建单 {{ fmtTime(order.createdAt) }}</p>
      </div>
      <span class="order-status" :class="`st-${order.status}`">{{ STATUS_LABELS[order.status] }}</span>
    </div>

    <!-- ============ 编辑态：草稿 / 待确认 ============ -->
    <template v-if="editable">
      <div class="field-grid">
        <label>
          起始表读数（km）
          <input
            type="number"
            min="0"
            step="1"
            :value="order.startMileage ?? ''"
            @input="patch({ startMileage: ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
        <label>
          结束表读数（km）
          <input
            type="number"
            min="0"
            step="1"
            :class="{ 'input-error': mileageInverted }"
            :value="order.endMileage ?? ''"
            @input="patch({ endMileage: ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
        <label>
          实际里程（km，自动）
          <input :value="actualMileage === null ? '' : actualMileage" readonly :class="{ 'input-error': mileageInverted }" />
        </label>
        <label>
          实际油耗（升）
          <input
            type="number"
            min="0"
            step="0.1"
            :value="order.fuelLiters ?? ''"
            @input="patch({ fuelLiters: ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
        <label>
          应收金额（元）
          <input
            type="number"
            min="0"
            step="0.01"
            :value="order.receivable ?? ''"
            @input="patch({ receivable: ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
      </div>

      <table class="fee-table">
        <thead>
          <tr>
            <th>费用项</th>
            <th>说明</th>
            <th class="num">明细金额</th>
            <th>票据号</th>
            <th class="num">票面金额</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <!-- 顶层路桥费：每单固定一项 -->
          <tr :class="{ 'row-error': duplicateTypes.has('toll') }">
            <td>
              {{ FEE_TYPE_LABELS.toll }}
              <span v-if="duplicateTypes.has('toll')" class="badge-warn">重复</span>
            </td>
            <td class="muted">高速/路桥通行</td>
            <td class="num">
              <input
                type="number"
                min="0"
                step="0.01"
                :value="order.tollAmount ?? ''"
                @input="patch({ tollAmount: ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value) })"
              />
            </td>
            <td>
              <input :value="order.tollTicketNo" placeholder="路桥票据号" @input="patch({ tollTicketNo: ($event.target as HTMLInputElement).value })" />
            </td>
            <td class="num muted">同明细金额</td>
            <td></td>
          </tr>

          <tr
            v-for="line in order.lines"
            :key="line.id"
            :class="{ 'row-error': duplicateTypes.has(line.feeType) || ticketMismatch(line) }"
          >
            <td>
              <select :value="line.feeType" @change="patchLine(line, { feeType: ($event.target as HTMLSelectElement).value as FeeType })">
                <option v-for="opt in lineTypeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>
              <span v-if="duplicateTypes.has(line.feeType)" class="badge-warn">重复</span>
            </td>
            <td>
              <input :value="line.name" :placeholder="FEE_TYPE_LABELS[line.feeType]" @input="patchLine(line, { name: ($event.target as HTMLInputElement).value })" />
            </td>
            <td class="num">
              <input
                type="number"
                min="0"
                step="0.01"
                :class="{ 'input-error': ticketMismatch(line) }"
                :value="line.amount"
                @input="patchLine(line, { amount: Number(($event.target as HTMLInputElement).value) })"
              />
            </td>
            <td>
              <input :value="line.ticketNo" placeholder="票据号码" @input="patchLine(line, { ticketNo: ($event.target as HTMLInputElement).value })" />
            </td>
            <td class="num">
              <input
                type="number"
                min="0"
                step="0.01"
                :class="{ 'input-error': ticketMismatch(line) }"
                :value="line.ticketAmount"
                @input="patchLine(line, { ticketAmount: Number(($event.target as HTMLInputElement).value) })"
            />
            </td>
            <td>
              <button type="button" class="mini danger" @click="store.removeDraftLine(order.id, line.id)">移除</button>
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td colspan="6">
              <button type="button" class="mini secondary" @click="store.addDraftLine(order.id)">+ 添加费用项</button>
            </td>
          </tr>
        </tfoot>
      </table>

      <label class="remark-field">
        回单备注
        <textarea :value="order.remark" placeholder="运输/核对说明" @input="patch({ remark: ($event.target as HTMLTextAreaElement).value })" />
      </label>

      <ConflictBox :conflicts="conflicts" />

      <div class="order-actions">
        <template v-if="order.status === 'draft'">
          <button type="button" @click="submit">核对并提交</button>
          <button type="button" class="danger ghost" @click="store.removeOrder(order.id)">删除回单</button>
        </template>
        <template v-else>
          <button type="button" @click="confirmSettlement">结算确认（冻结快照）</button>
          <button type="button" class="secondary" @click="backToDraft">退回修改</button>
        </template>
      </div>
    </template>

    <!-- ============ 确认态：快照冻结 + 修订链 ============ -->
    <template v-else>
      <div class="freeze-banner">
        🔒 费用快照已于 {{ fmtTime(frozen?.frozenAt) }} 冻结，原始数据不可修改；补录票据将生成新修订并保留原值
      </div>

      <div class="view-toggle">
        <button type="button" class="mini" :class="{ active: viewMode === 'effective' }" @click="viewMode = 'effective'">当前生效值（含 {{ order.revisions.length }} 次修订）</button>
        <button type="button" class="mini" :class="{ active: viewMode === 'snapshot' }" @click="viewMode = 'snapshot'">冻结快照原值</button>
      </div>

      <div class="frozen-summary">
        <div class="sum-item">
          <span>实际里程</span>
          <strong>{{ viewTotals.mileage }} km</strong>
          <small>{{ viewMode === 'snapshot' ? frozen?.startMileage : eff.startMileage }} → {{ viewMode === 'snapshot' ? frozen?.endMileage : eff.endMileage }}</small>
        </div>
        <div class="sum-item">
          <span>实际油耗</span>
          <strong>{{ viewTotals.fuel }} L</strong>
          <small>百公里 {{ round2(viewTotals.fuel / Math.max(viewTotals.mileage, 1) * 100) }} L</small>
        </div>
        <div class="sum-item">
          <span>费用合计</span>
          <strong>{{ money(viewTotals.expense) }}</strong>
          <small>路桥 + 明细</small>
        </div>
        <div class="sum-item">
          <span>应收金额</span>
          <strong class="receive">{{ money(viewTotals.receivable) }}</strong>
          <small>确认于 {{ fmtTime(order.confirmedAt) }}</small>
        </div>
      </div>

      <table class="fee-table readonly">
        <thead>
          <tr>
            <th>费用项</th>
            <th>说明</th>
            <th class="num">金额</th>
            <th>票据号</th>
            <th>来源</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="viewToll > 0">
            <td>{{ FEE_TYPE_LABELS.toll }}</td>
            <td class="muted">高速/路桥通行</td>
            <td class="num">{{ money(viewToll) }}</td>
            <td>{{ viewMode === 'snapshot' ? frozen?.tollTicketNo : eff.toll?.ticketNo }}</td>
            <td>
              <span v-if="viewMode === 'snapshot'" class="tag-base">快照原值</span>
              <span v-else-if="eff.toll?.lastAdjustedSeq" class="tag-rev">第 {{ eff.toll.lastAdjustedSeq }} 次修订调整</span>
              <span v-else class="tag-base">快照原值</span>
            </td>
          </tr>
          <tr v-for="row in viewLines" :key="row.line.id">
            <td>{{ FEE_TYPE_LABELS[row.line.feeType] }}</td>
            <td class="muted">{{ lineLabel(row.line) }}</td>
            <td class="num">{{ money(row.line.amount) }}</td>
            <td>{{ row.line.ticketNo }}</td>
            <td>
              <template v-if="viewMode === 'snapshot'">
                <span class="tag-base">快照原值</span>
              </template>
              <template v-else>
                <span v-if="row.meta.addedAt !== 'base'" class="tag-rev">第 {{ row.meta.addedAt }} 次修订补录</span>
                <span v-else-if="row.meta.lastAdjustedSeq" class="tag-rev">第 {{ row.meta.lastAdjustedSeq }} 次修订调整</span>
                <span v-else class="tag-base">快照原值</span>
              </template>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 修订链 -->
      <div class="revision-chain">
        <p class="chain-title">修订链（{{ order.revisions.length }}）</p>
        <div v-if="order.revisions.length === 0" class="chain-empty">暂无修订</div>
        <ol>
          <li v-for="rev in order.revisions" :key="rev.id" class="chain-item">
            <p>
              <strong>第 {{ rev.seq }} 次修订</strong>
              <span class="muted">{{ fmtTime(rev.createdAt) }}</span>
            </p>
            <p class="chain-reason">原因：{{ rev.reason }}</p>
            <ul class="chain-detail">
              <li v-for="line in rev.addedLines" :key="line.id">
                <span class="tag-rev">补录</span>
                {{ FEE_TYPE_LABELS[line.feeType] }}（{{ lineLabel(line) }}）{{ money(line.amount) }}，票据 {{ line.ticketNo }}
              </li>
              <li v-for="adj in rev.adjustments" :key="adj.lineId">
                <span class="tag-adj">调整</span>
                金额 {{ money(adj.prevAmount) }}（原票 {{ adj.prevTicketNo || '—' }} / {{ money(adj.prevTicketAmount) }}）
                → {{ money(adj.amount) }}（新票 {{ adj.ticketNo || '—' }} / {{ money(adj.ticketAmount) }}），原值保留
              </li>
            </ul>
          </li>
        </ol>
      </div>

      <p v-if="order.remark" class="frozen-remark">备注：{{ order.remark }}</p>

      <div class="order-actions">
        <button type="button" @click="showRevision = true">补录票据 / 发起修订</button>
      </div>

      <RevisionDialog v-if="showRevision" :order="order" @close="showRevision = false" />
    </template>
  </article>
</template>
