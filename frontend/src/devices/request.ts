/** nexnotes' client for the module geraete (`vendor/nexgeraete`): its tab header, its errors with their codes. */
import { api } from '../api/client'
import type { DeviceRequest } from '../vendor/nexgeraete'

export const deviceRequest: DeviceRequest = <T,>(path: string, init: Parameters<DeviceRequest>[1] = {}) =>
  api<T>(path, { method: init.method, query: init.query, body: init.body })
