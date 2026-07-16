import { defineStore } from 'pinia'

export const useAccountStore = defineStore('account', {
    state: () => ({
        currentAccountId: 0,
        currentAccount: {},
        changeUserAccountName: '',
        accounts: [],
    }),
    actions: {
        replaceAccounts(accounts) {
            this.accounts = accounts.map(account => ({...account}))
        },
        mergeAccounts(accounts) {
            const merged = new Map(this.accounts.map(account => [account.accountId, account]))
            accounts.forEach(account => merged.set(account.accountId, {...merged.get(account.accountId), ...account}))
            this.accounts = [...merged.values()]
        },
        removeAccount(accountId) {
            this.accounts = this.accounts.filter(account => account.accountId !== accountId)
        },
    },
})
