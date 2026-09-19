# 运输回单结算台

- 行业：物流
- 技术栈：Vue3、Vite、TypeScript、Pinia、Element Plus
- 启动：`npm install && npm run dev`
- 构建：`npm run build`
- 逻辑冒烟测试：`npx esbuild scripts/smoke.ts --bundle --platform=node --format=esm --outfile=/tmp/smoke.mjs && node /tmp/smoke.mjs`

在车辆调度原型基础上改造的可核对运输回单结算台，数据保存在浏览器 localStorage（key：`dfwlfront-3-settlement-v1`），刷新后结算单、票据与修订链全部保留。

## 核心能力

1. **每单记录实际数据**：起始/结束里程表读数（实际里程自动相减）、实际油耗（升）、路桥费（含票据号）、动态费用明细（油费/停车费/装卸费/其他，含票据号与票面金额）、应收金额。
2. **防重复报销**：同一任务下同一费用项仅可报销一次，跨已确认结算单同样拦截；同一张票据号全单据唯一。
3. **提交前冲突核对**（任一冲突即阻止提交并逐项列出）：
   - `mileage-internal`：本单里程倒挂（结束读数 < 起始读数）
   - `mileage-overlap`：与同车辆其他回单的里程区间倒挂
   - `duplicate-line` / `duplicate-task`：单内/跨单同一费用项重复
   - `duplicate-ticket`：票据号重复
   - `ticket-mismatch`：票据票面金额与明细金额不一致（列出差额）
   - `ticket-missing` / `missing`：票据号或必填金额缺失
4. **结算确认即冻结**：确认时生成费用快照（里程、油耗、路桥、各行金额、票据号、合计、冻结时间），已确认单据不可编辑或删除。
5. **补录只能走修订链**：确认后补录票据或更正金额必须发起修订，记录原因、补录行、「原值 → 新值」调整；快照原值与每次修订完整保留，可在「当前生效值 / 冻结快照原值」两个视图间切换核对。
6. **修订同样强校验**：补录重复费用项、票明不一致、票据号冲突、无原因等情况都会阻止修订落链。

## 目录

- `src/types.ts`：领域模型（回单、费用行、快照、修订、冲突）
- `src/validation.ts`：提交校验、报销台账、快照 + 修订链的生效值投影
- `src/store.ts`：Pinia store、localStorage 持久化、快照冻结与修订追加
- `src/components/OrderCard.vue`：回单编辑态/确认态卡片
- `src/components/RevisionDialog.vue`：补录票据与金额调整修订对话框
- `src/components/ConflictBox.vue`：冲突清单
- `scripts/smoke.ts`：核心规则的 Node 冒烟测试（23 项断言）
