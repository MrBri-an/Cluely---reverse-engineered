import type { SpecterApi } from '../shared/types'

declare global {
  interface Window {
    specter: SpecterApi
  }
}

export {}
