<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { storeToRefs } from "pinia";
import type { TaskStatus } from "./types";
import { STATUS_LABELS, TASK_STATUS } from "./types";
import { useSettlementStore } from "./store";
import OrderCard from "./components/OrderCard.vue";

const store = useSettlementStore();
const { tasks, orders } = storeToRefs(store);

const ZONES = ["全部区域", "城北", "城东", "城南"];
const zone = ref("全部区域");

const taskForm = reactive({
  vehicle: "",
  driver: "",
  zone: "城北",
  task: "",
  status: "执行中" as TaskStatus
});

const filteredTasks = computed(() =>
  zone.value === "全部区域" ? tasks.value : tasks.value.filter((t) => t.zone === zone.value)
);

const pendingCount = computed(() => orders.value.filter((o) => o.status !== "confirmed").length);
const confirmedCount = computed(() => orders.value.filter((o) => o.status === "confirmed").length);
const frozenReceivable = computed(() =>
  orders.value
    .filter((o) => o.status === "confirmed")
    .reduce((sum, o) => sum + (o.snapshot?.receivable ?? 0), 0)
);
const totalMileage = computed(() =>
  orders.value
    .filter((o) => o.status === "confirmed")
    .reduce((sum, o) => {
      const eff = store.effective(o);
      return sum + eff.actualMileage;
    }, 0)
);

function submitTask() {
  if (!taskForm.vehicle.trim() || !taskForm.driver.trim() || !taskForm.task.trim()) return;
  store.addTask({ ...taskForm });
  taskForm.vehicle = "";
  taskForm.driver = "";
  taskForm.task = "";
}

function taskById(id: string) {
  return tasks.value.find((t) => t.id === id);
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">物流运输 · 回单结算闭环</p>
          <h1>运输回单结算台</h1>
          <p class="subtitle">
            每单记录实际里程、油耗、路桥费和应收；同一任务同一费用项不得重复报销，里程倒挂或票据金额与明细不一致时阻止提交并列出冲突项。
            结算确认后费用快照冻结，补录票据只生成新修订并保留原值；数据持久化，刷新后结算、票据与修订链均保留。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">Pinia</span>
          <span class="tag">快照冻结</span>
          <span class="tag">修订链审计</span>
        </div>
      </header>

      <section class="metrics">
        <article class="metric">
          <span>调度任务</span>
          <strong>{{ tasks.length }}</strong>
        </article>
        <article class="metric">
          <span>待核对回单</span>
          <strong>{{ pendingCount }}</strong>
        </article>
        <article class="metric">
          <span>已确认结算单</span>
          <strong>{{ confirmedCount }}</strong>
        </article>
        <article class="metric">
          <span>已冻结应收</span>
          <strong>¥{{ frozenReceivable.toFixed(2) }}</strong>
        </article>
      </section>

      <section class="workspace">
        <!-- 左：新增调度任务 -->
        <form class="panel" @submit.prevent="submitTask">
          <h2>新增调度任务</h2>
          <div class="form-grid">
            <label>
              车牌号
              <input v-model="taskForm.vehicle" placeholder="如 沪A-82L6" required />
            </label>
            <label>
              司机
              <input v-model="taskForm.driver" placeholder="司机姓名" required />
            </label>
            <label>
              配送区域
              <select v-model="taskForm.zone">
                <option v-for="z in ZONES.slice(1)" :key="z" :value="z">{{ z }}</option>
              </select>
            </label>
            <label>
              配送任务
              <input v-model="taskForm.task" placeholder="如 商超补货" required />
            </label>
            <label>
              任务状态
              <select v-model="taskForm.status">
                <option v-for="s in TASK_STATUS" :key="s" :value="s">{{ s }}</option>
              </select>
            </label>
            <button type="submit">派发任务</button>
          </div>

          <div class="tip">
            <p>核对规则</p>
            <ul>
              <li>同一任务同一费用项仅可报销一次（含跨已确认单校验）</li>
              <li>同一张票据号不可在本单或其他单重复使用</li>
              <li>结束里程不得小于起始里程，并与同车回单衔接校验</li>
              <li>明细金额必须与票面金额一致，否则阻止提交</li>
              <li>确认后仅可通过补录修订变更，原值全部保留</li>
            </ul>
          </div>
        </form>

        <!-- 右：任务 + 回单 -->
        <section class="list-panel">
          <div class="toolbar">
            <h2>任务与回单</h2>
            <select v-model="zone">
              <option v-for="z in ZONES" :key="z" :value="z">{{ z }}</option>
            </select>
          </div>

          <div class="task-list">
            <div v-if="filteredTasks.length === 0" class="empty">暂无匹配任务</div>

            <article v-for="task in filteredTasks" :key="task.id" class="task-card">
              <div class="task-head">
                <div>
                  <p class="task-title">
                    {{ task.code }} · {{ task.vehicle }}
                    <span class="task-driver">{{ task.driver }} · {{ task.zone }} · {{ task.task }}</span>
                  </p>
                  <p class="task-time">派发于 {{ fmt(task.createdAt) }}</p>
                </div>
                <div class="task-side">
                  <span class="status" :class="task.status === '已完成' ? 'st-done' : 'st-running'">{{ task.status }}</span>
                  <button
                    type="button"
                    class="mini secondary"
                    :disabled="task.status === '已完成'"
                    @click="store.setTaskStatus(task.id, '已完成')"
                  >
                    标记完成
                  </button>
                  <button type="button" class="mini" @click="store.createOrder(task.id)">登记回单</button>
                </div>
              </div>

              <div v-if="store.ordersByTask.get(task.id)?.length" class="order-list">
                <OrderCard
                  v-for="order in store.ordersByTask.get(task.id)"
                  :key="order.id"
                  :order="order"
                  :task="task"
                />
              </div>
              <div v-else class="empty small">该任务暂无回单</div>
            </article>
          </div>

          <div class="mini-chart">
            <div class="bar">
              <span>已确认回单</span>
              <div class="bar-track">
                <div
                  class="bar-fill"
                  :style="{ width: `${(confirmedCount / Math.max(orders.length, 1)) * 100}%` }"
                />
              </div>
              <strong>{{ confirmedCount }}/{{ orders.length }}</strong>
            </div>
            <div class="bar">
              <span>合计实际里程</span>
              <div class="bar-track">
                <div class="bar-fill alt" :style="{ width: '100%' }" />
              </div>
              <strong>{{ totalMileage }} km</strong>
            </div>
          </div>
        </section>
      </section>
    </div>
  </main>
</template>
