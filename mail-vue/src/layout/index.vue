<template>
  <el-container class="layout">
    <el-aside
        class="aside"
        :class="uiStore.asideShow ? 'aside-show' : 'el-aside-hide'">
      <Aside />
    </el-aside>
    <div
        :class="(uiStore.asideShow && isMobile)? 'overlay-show':'overlay-hide'"
        @click="uiStore.asideShow = false"
    ></div>
    <el-container class="main-container">
      <el-main>
        <el-header>
            <Header />
        </el-header>
        <Main />
      </el-main>
    </el-container>
  </el-container>
  <writer ref="writerRef" />
</template>

<script setup>
import Aside from '@/layout/aside/index.vue'
import Header from '@/layout/header/index.vue'
import Main from '@/layout/main/index.vue'
import { ref, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import {useUiStore} from "@/store/ui.js";
import writer from '@/layout/write/index.vue'
import {useRoute, useRouter} from 'vue-router'
import {useI18n} from 'vue-i18n'
import {parseMailto, storePendingMailto, takePendingMailto} from '@/utils/mailto.js'
import {createNewMailNotifier} from '@/services/new-mail-notifier.js'
import {useSettingStore} from '@/store/setting.js'

const uiStore = useUiStore();
const settingStore = useSettingStore()
const route = useRoute()
const router = useRouter()
const {t} = useI18n()
const mailNotifier = createNewMailNotifier(t)
const writerRef = ref({})
const isMobile = ref(window.innerWidth < 1025)
let mounted = false
let processingMailto = false
const handleResize = () => {
  isMobile.value = window.innerWidth < 1025
  uiStore.asideShow = window.innerWidth > 1024;
}

async function consumeMailto(uri, removeQuery = false) {
  if (!uri || processingMailto) return
  processingMailto = true
  let queryConsumed = !removeQuery

  try {
    if (removeQuery) {
      const query = {...route.query}
      delete query.mailto
      await router.replace({path: route.path, query, hash: route.hash})
      queryConsumed = true
    }
    await nextTick()
    await writerRef.value.openMailto(parseMailto(uri))
  } catch (error) {
    console.error('mailto activation failed', error)
    storePendingMailto(uri)
    ElNotification({
      title: t('mailtoOpenFailed'),
      message: t('reqFailErrorMsg'),
      type: 'error',
      position: 'bottom-right'
    })
  } finally {
    processingMailto = false
    if (queryConsumed && mounted && typeof route.query.mailto === 'string') {
      const queuedUri = route.query.mailto
      await nextTick()
      consumeMailto(queuedUri, true)
    }
  }
}

watch(() => route.query.mailto, value => {
  if (mounted && typeof value === 'string') {
    consumeMailto(value, true)
  }
})

function syncMailNotifier() {
  if (!mounted) return
  if (settingStore.mailNotificationsEnabled || Number(settingStore.settings.autoRefresh) > 1) mailNotifier.start()
  else mailNotifier.stop()
}

watch(
    () => [settingStore.mailNotificationsEnabled, settingStore.settings.autoRefresh],
    syncMailNotifier
)

onMounted(async () => {
  uiStore.writerRef = writerRef
  mounted = true

  window.addEventListener('resize', handleResize)
  handleResize()

  syncMailNotifier()

  if (typeof route.query.mailto === 'string') {
    await consumeMailto(route.query.mailto, true)
  } else {
    await consumeMailto(takePendingMailto())
  }
})

onBeforeUnmount(() => {
  mounted = false
  mailNotifier.stop()
  window.removeEventListener('resize', handleResize)
})
</script>

<style lang="scss" scoped>
.el-aside-hide {
  position: fixed;
  left: 0;
  height: 100%;
  z-index: 100;
  transform: translateX(-100%);
  transition: all 100ms ease;
}

.aside-show {
  -webkit-box-shadow: var(--aside-right-border);
  box-shadow: var(--aside-right-border);
  transform: translateX(0);
  transition: all 100ms ease;
  z-index: 101;
  @media (max-width: 1025px) {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 101;
    height: 100%;
    background: var(--el-bg-color);
  }
}

.el-aside {
  width: auto;
  transition: all 100ms ease;
}

.layout {
  height: 100%;
  position: fixed;
  width: 100%;
  top: 0;
  left: 0;
  overflow: hidden;
}

.main-container {
  min-height: 100%;
  background: var(--el-bg-color);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.el-main {
  padding: 0;
}

.el-header {
  background: var(--el-bg-color);
  border-bottom: solid 1px var(--el-border-color);
  padding: 0 0 0 0;
}

.overlay-show {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.4);
  z-index: 99;
  transition: all 0.3s;
}

.overlay-hide {
  display: flex;
  pointer-events: none;
  opacity: 0;
}
</style>
