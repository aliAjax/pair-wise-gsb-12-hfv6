<script setup lang="ts">
import type { Conflict } from "../types";

defineProps<{ conflicts: Conflict[] }>();
</script>

<template>
  <div v-if="conflicts.length" class="conflict-box">
    <p class="conflict-title">⚠️ 检测到 {{ conflicts.length }} 项冲突，已阻止提交：</p>
    <ul>
      <li v-for="(conflict, index) in conflicts" :key="index" class="conflict-item">
        <span class="conflict-code">{{ conflict.code }}</span>
        {{ conflict.message }}
      </li>
    </ul>
  </div>
</template>
