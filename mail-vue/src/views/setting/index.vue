<template>
  <div class="box">
    <div class="container">
      <div class="title">{{$t('profile')}}</div>
      <div class="item">
        <div>{{$t('username')}}</div>
        <div>
          <span v-if="setNameShow" class="edit-name-input">
            <el-input v-model="accountName"  ></el-input>
            <span class="edit-name" @click="setName">
             {{$t('save')}}
            </span>
          </span>
          <span v-else class="user-name">
            <span >{{ userStore.user.name }}</span>
            <span class="edit-name" @click="showSetName">
             {{$t('change')}}
            </span>
          </span>
        </div>
      </div>
      <div class="item">
        <div>{{$t('emailAccount')}}</div>
        <div>{{ userStore.user.email }}</div>
      </div>
      <div class="item">
        <div>{{$t('password')}}</div>
        <div>
          <el-button type="primary" @click="pwdShow = true">{{$t('changePwdBtn')}}</el-button>
        </div>
      </div>
    </div>
    <div class="preferences">
      <div class="title">{{$t('defaultSendingEmail')}}</div>
      <div class="preference-item">
        <div>
          <div class="preference-name">{{$t('mailtoHandler')}}</div>
          <div class="preference-desc">{{$t('mailtoHandlerDesc')}}</div>
        </div>
        <div class="preference-actions">
          <el-button type="primary" @click="registerMailtoHandler">{{$t('registerMailtoHandler')}}</el-button>
          <el-button @click="openDefaultApps">{{$t('openWindowsDefaultApps')}}</el-button>
        </div>
        <div v-if="mailtoRegistrationStatus" class="preference-status">{{mailtoRegistrationStatus}}</div>
      </div>
      <div class="preference-item notification-item">
        <div>
          <div class="preference-name">{{$t('newMailNotifications')}}</div>
          <div class="preference-desc">{{$t('newMailNotificationsDesc')}}</div>
        </div>
        <el-switch
            :model-value="settingStore.mailNotificationsEnabled"
            :loading="notificationLoading"
            @change="toggleMailNotifications"
        />
        <div class="preference-status">{{notificationStatus}}</div>
      </div>
    </div>
    <div class="language">
      <div class="title">{{$t('language')}}</div>
      <el-select
          :model-value="langSelect"
          class="language-select"
          placeholder="Select"
          @change="changeLang"
      >
        <el-option label="中文" value="zh" @pointerdown.prevent.stop="changeLang('zh')"/>
        <el-option label="English" value="en" @pointerdown.prevent.stop="changeLang('en')"/>
      </el-select>
    </div>
    <div class="del-email" v-perm="'my:delete'">
      <div class="title">{{$t('deleteUser')}}</div>
      <div style="color: var(--regular-text-color);">
        {{$t('delAccountMsg')}}
      </div>
      <div>
        <el-button type="primary" @click="deleteConfirm">{{$t('deleteUserBtn')}}</el-button>
      </div>
    </div>
    <el-dialog v-model="pwdShow" :title="$t('changePassword')" width="340">
      <div class="update-pwd">
        <el-input type="password" :placeholder="$t('newPassword')" v-model="form.password" autocomplete="off"/>
        <el-input type="password" :placeholder="$t('confirmPassword')" v-model="form.newPwd" autocomplete="off"/>
        <el-button type="primary" :loading="setPwdLoading" @click="submitPwd">{{$t('save')}}</el-button>
      </div>
    </el-dialog>
  </div>
</template>
<script setup>
import {reactive, ref, defineOptions, onMounted} from 'vue'
import {resetPassword, userDelete} from "@/request/my.js";
import {useUserStore} from "@/store/user.js";
import router from "@/router/index.js";
import {accountSetName} from "@/request/account.js";
import {useAccountStore} from "@/store/account.js";
import {useI18n} from "vue-i18n";
import {useSettingStore} from "@/store/setting.js";
import {
  disablePushNotifications,
  enablePushNotifications,
  getPushNotificationState,
} from '@/services/push-notifications.js'

const { t } = useI18n()
const accountStore = useAccountStore()
const settingStore = useSettingStore()
const userStore = useUserStore();
const setPwdLoading = ref(false)
const setNameShow = ref(false)
const accountName = ref(null)
const langSelect = ref(settingStore.lang)
const mailtoRegistrationStatus = ref('')
const notificationStatus = ref('')
const notificationLoading = ref(false)

defineOptions({
  name: 'setting'
})

function notificationStatusText(state) {
  if (!state.supported) return t('pushNotificationsUnsupported')
  if (state.permission === 'denied') return t('desktopNotificationsDenied')
  if (state.subscribed) return t('pushNotificationsActive')
  if (state.permission === 'granted') return t('pushNotificationsReady')
  return t('desktopNotificationsNotRequested')
}

async function refreshNotificationStatus() {
  const state = await getPushNotificationState()
  settingStore.pushNotificationsEnabled = Boolean(state.subscribed)
  notificationStatus.value = notificationStatusText(state)
}

onMounted(() => refreshNotificationStatus())

function registerMailtoHandler() {
  if (!navigator.registerProtocolHandler) {
    mailtoRegistrationStatus.value = t('mailtoHandlerUnsupported')
    return
  }

  try {
    navigator.registerProtocolHandler('mailto', `${window.location.origin}/inbox?mailto=%s`)
    mailtoRegistrationStatus.value = t('mailtoRegistrationRequested')
  } catch (error) {
    console.error('mailto registration failed', error)
    mailtoRegistrationStatus.value = t('mailtoRegistrationFailed')
  }
}

function openDefaultApps() {
  window.open('ms-settings:defaultapps', '_self')
}

async function toggleMailNotifications(enabled) {
  notificationLoading.value = true
  try {
    if (!enabled) {
      settingStore.mailNotificationsEnabled = false
      const state = await disablePushNotifications()
      settingStore.pushNotificationsEnabled = false
      notificationStatus.value = notificationStatusText(state)
      return
    }

    settingStore.mailNotificationsEnabled = true
    try {
      const state = await enablePushNotifications({requestPermission: true})
      settingStore.pushNotificationsEnabled = Boolean(state.subscribed)
      notificationStatus.value = notificationStatusText(state)
    } catch (error) {
      settingStore.pushNotificationsEnabled = false
      notificationStatus.value = t('pushNotificationsSetupFailed')
      console.error('Web Push setup failed', error)
    }
  } finally {
    notificationLoading.value = false
  }
}

function showSetName() {
  accountName.value = userStore.user.name
  setNameShow.value = true
}

function setName() {

  if (!accountName.value) {
    ElMessage({
      message: t('emptyUserNameMsg'),
      type: 'error',
      plain: true,
    })
    return;
  }

  setNameShow.value = false
  let name = accountName.value

  if (name === userStore.user.name) {
    return
  }

  userStore.user.name = accountName.value

  accountSetName(userStore.user.account.accountId,name).then(() => {
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })

    accountStore.changeUserAccountName = name

  }).catch(() => {
    userStore.user.name = name
  })
}

function changeLang(lang) {
  let setting = {}
  try {
    setting = JSON.parse(localStorage.getItem('setting') || '{}')
  } catch (e) {
    setting = {}
  }
  localStorage.setItem('setting', JSON.stringify({...setting, lang}))
  window.location.reload()
}

const pwdShow = ref(false)
const form = reactive({
  password: '',
  newPwd: '',
})

const deleteConfirm = () => {
  ElMessageBox.confirm(t('delAccountConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(async () => {
    try {
      await disablePushNotifications()
    } catch (error) {
      console.warn('Web Push cleanup before account deletion failed', error)
    }
    userDelete().then(() => {
      localStorage.removeItem('token');
      router.replace('/login');
      ElMessage({
        message: t('delSuccessMsg'),
        type: 'success',
        plain: true,
      })
    })
  })
}


function submitPwd() {

  if (!form.password) {
    ElMessage({
      message: t('emptyPwdMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (form.password.length < 6) {
    ElMessage({
      message: t('pwdLengthMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (form.password !== form.newPwd) {
    ElMessage({
      message: t('confirmPwdFailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  setPwdLoading.value = true
  resetPassword(form.password).then(() => {
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })
    pwdShow.value = false
    setPwdLoading.value = false
    form.password = ''
    form.newPwd = ''
  }).catch(() => {
    setPwdLoading.value = false
  })

}

</script>
<style scoped lang="scss">
.box {
  padding: 40px 40px;

  @media (max-width: 767px) {
    padding: 30px 30px;
  }

  .update-pwd {
    display: flex;
    flex-direction: column;
    gap: 15px;
  }

  .title {
    font-size: 18px;
    font-weight: bold;
  }

  .container {
    font-size: 14px;
    display: grid;
    gap: 20px;
    margin-bottom: 40px;

    .item {
      display: grid;
      grid-template-columns: 50px 1fr;
      gap: 140px;
      position: relative;
      .user-name {
        display: grid;
        grid-template-columns: auto 1fr;
        span:first-child {
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }
      }

      .edit-name-input {
        position: absolute;
        bottom: -6px;
        .el-input {
          width: min(200px,calc(100vw - 222px));
        }
      }

      .edit-name {
        color: #4dabff;
        padding-left: 10px;
        cursor: pointer;
      }

      @media (max-width: 767px) {
        gap: 70px;
      }

      div:first-child {
        font-weight: bold;
      }

      div:last-child {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
    }
  }

  .language {
    display: flex;
    flex-direction: column;
    gap: 20px;
    margin-bottom: 40px;

    .language-select {
      width: 100px;
    }
  }

  .preferences {
    display: flex;
    flex-direction: column;
    gap: 20px;
    margin-bottom: 40px;

    .preference-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 12px;
      max-width: 720px;
      padding: 16px;
      border: 1px solid var(--el-border-color);
      border-radius: 8px;
    }

    .notification-item {
      grid-template-columns: minmax(0, 1fr) auto;

      .preference-status {
        grid-column: 1 / -1;
      }
    }

    .preference-name {
      font-size: 14px;
      font-weight: bold;
    }

    .preference-desc,
    .preference-status {
      margin-top: 5px;
      color: var(--regular-text-color);
      font-size: 13px;
      white-space: normal;
    }

    .preference-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;

      .el-button {
        margin-left: 0;
      }
    }
  }

  .del-email {
    font-size: 14px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
}
</style>
