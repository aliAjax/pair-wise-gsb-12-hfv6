<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import type { ExpenseLine, FeeType, SettlementOrder } from "../types";
import { DETAIL_FEE_TYPES, FEE_TYPE_LABELS } from "../types";
import { lineLabel, projectEffective, round2 } from "../validation";
import { useSettlementStore, type RevisionDraft } from "../store";
import ConflictBox from "./ConflictBox.vue";

const props = defineProps<{ order: SettlementOrder }>();
const emit = defineEmits<{ close: [] }>();

const store = useSettlementStore();
const eff = computed(() => projectEffective(props.order));

const reason = ref("");
const conflicts = ref<{ code: string; message: string }[]>([]);

interface AddedRow {
  id: string;
  feeType: FeeType;
  name: string;
  amount: number;
  ticketNo: string;
  ticketAmount: number;
}
interface AdjustRow {
  lineId: string;
  name: string;
  feeType: FeeType;
  prevAmount: number;
  prevTicketNo: string;
  prevTicketAmount: number;
  enabled: boolean;
  amount: string;
  ticketNo: string;
  ticketAmount: string;
}

function uid() {
  return `line-${crypto.randomUUID().slice(0, 8)}`;
}

function blankAdded(): AddedRow {
  return { id: uid(), feeType: "other", name: "", amount: 0, ticketNo: "", ticketAmount: 0 };
}

// 可补录的费用项：当前生效值中未出现（金额为 0 的路桥费也可补录）
const addableTypes = computed<FeeType[]>(() => {
  const used = new Set(eff.value.lines.filter((l) => l.amount > 0).map((l) => l.feeType));
  if (eff.value.toll && eff.value.toll.amount > 0) used.add("toll");
  return (["toll", ...DETAIL_FEE_TYPES] as FeeType[]).filter((t) => !used.has(t));
});

const addedRows = ref<AddedRow[]>([]);
function addRow() {
  const row = blankAdded();
  row.feeType = addableTypes.value[0] ?? "other";
  addedRows.value.push(row);
}
function removeRow(id: string) {
  addedRows.value = addedRows.value.filter((r) => r.id !== id);
}

// 可调行：顶层路桥费 + 快照/修订中的全部费用行
const adjustRows = reactive<AdjustRow[]>([]);
function initAdjustRows() {
  const push = (lineId: string, feeType: FeeType, name: string, amount: number, ticketNo: string, ticketAmount: number) => {
    adjustRows.push({
      lineId,
      feeType,
      name,
      prevAmount: amount,
      prevTicketNo: ticketNo,
      prevTicketAmount: ticketAmount,
      enabled: false,
      amount: String(round2(amount)),
      ticketNo,
      ticketAmount: String(round2(ticketAmount))
    });
  };
  if (eff.value.toll) {
    push("__toll__", "toll", "路桥费", eff.value.toll.amount, eff.value.toll.ticketNo, eff.value.toll.ticketAmount);
  }
  eff.value.lines.forEach((l) => push(l.id, l.feeType, lineLabel(l), l.amount, l.ticketNo, l.ticketAmount));
}
initAdjustRows();

function syncToll(row: AdjustRow) {
  if (row.feeType === "toll") row.ticketAmount = row.amount;
}

function money(n: number) {
  return `${round2(n).toFixed(2)} 元`;
}

function submit() {
  const draft: RevisionDraft = {
    reason: reason.value,
    added: addedRows.value.map(
      (r): ExpenseLine => ({
        id: r.id,
        feeType: r.feeType,
        name: r.name,
        amount: Number(r.amount) || 0,
        ticketNo: r.ticketNo,
        ticketAmount: Number(r.ticketAmount) || 0
      })
    ),
    adjustments: adjustRows
      .filter((r) => r.enabled)
      .map((r) => ({
        lineId: r.lineId,
        amount: r.amount === "" ? NaN : Number(r.amount),
        ticketNo: r.ticketNo,
        ticketAmount: r.ticketAmount === "" ? NaN : Number(r.ticketAmount)
      }))
  };
  const result = store.addRevision(props.order.id, draft);
  if (result.length > 0) {
    conflicts.value = result;
    return;
  }
  emit("close");
}
</script>

<template>
  <div class="dialog-mask" @click.self="emit('close')">
    <div class="dialog">
      <header class="dialog-head">
        <h3>补录票据 / 新修订 — {{ order.code }}</h3>
        <button type="button" class="mini secondary" @click="emit('close')">关闭</button>
      </header>
      <p class="dialog-hint">
        原快照保持冻结：新增票据作为补录行追加；修改已有金额将记录「原值 → 新值」。提交后生成第 {{ order.revisions.length + 1 }} 次修订。
      </p>

      <label class="dialog-reason">
        修订原因（必填）
        <input v-model="reason" placeholder="如：回单返回后补报停车票 / 票面金额录入更正" />
      </label>

      <!-- 补录 -->
      <section class="rev-section">
        <div class="rev-section-head">
          <h4>补录票据</h4>
          <button type="button" class="mini secondary" :disabled="addableTypes.length === 0" @click="addRow">
            + 添加补录行
          </button>
        </div>
        <p v-if="addableTypes.length === 0" class="muted">所有费用项均已报销，无法继续补录；如需变更请使用下方调整。</p>
        <table v-if="addedRows.length" class="fee-table">
          <thead>
            <tr>
              <th>费用项</th>
              <th>说明</th>
              <th class="num">金额</th>
              <th>票据号</th>
              <th class="num">票面金额</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in addedRows" :key="row.id">
              <td>
                <select v-model="row.feeType">
                  <option v-for="t in addableTypes" :key="t" :value="t">{{ FEE_TYPE_LABELS[t] }}</option>
                </select>
              </td>
              <td><input v-model="row.name" :placeholder="FEE_TYPE_LABELS[row.feeType]" /></td>
              <td class="num"><input v-model.number="row.amount" type="number" min="0" step="0.01" /></td>
              <td><input v-model="row.ticketNo" placeholder="票据号码" /></td>
              <td class="num">
                <input
                  v-model.number="row.ticketAmount"
                  type="number"
                  min="0"
                  step="0.01"
                  :disabled="row.feeType === 'toll'"
                  @input="row.feeType === 'toll' && (row.ticketAmount = row.amount)"
                />
              </td>
              <td><button type="button" class="mini danger" @click="removeRow(row.id)">移除</button></td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- 调整 -->
      <section class="rev-section">
        <h4>调整已有费用（原值保留）</h4>
        <table class="fee-table">
          <thead>
            <tr>
              <th class="ck">调整</th>
              <th>费用项</th>
              <th class="num">原金额</th>
              <th>原票据号</th>
              <th class="num">新金额</th>
              <th>新票据号</th>
              <th class="num">新票面</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in adjustRows" :key="row.lineId" :class="{ 'row-adjust': row.enabled }">
              <td><input type="checkbox" v-model="row.enabled" class="checkbox" /></td>
              <td>{{ row.feeType === 'toll' ? '路桥费' : FEE_TYPE_LABELS[row.feeType] }} <span class="muted">{{ row.feeType === 'toll' ? '' : row.name }}</span></td>
              <td class="num muted">{{ money(row.prevAmount) }}</td>
              <td class="muted">{{ row.prevTicketNo || '—' }}</td>
              <td class="num">
                <input v-model="row.amount" type="number" step="0.01" :disabled="!row.enabled" @input="syncToll(row)" />
              </td>
              <td><input v-model="row.ticketNo" :disabled="!row.enabled" placeholder="新票据号" /></td>
              <td class="num">
                <input v-model="row.ticketAmount" type="number" step="0.01" :disabled="!row.enabled || row.feeType === 'toll'" />
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <ConflictBox :conflicts="conflicts" />

      <footer class="dialog-foot">
        <button type="button" @click="submit">生成修订并追加到修订链</button>
        <button type="button" class="secondary" @click="emit('close')">取消</button>
      </footer>
    </div>
  </div>
</template>
