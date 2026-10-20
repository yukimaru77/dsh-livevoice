export const PLUGIN_ID = 'dsh-livevoice'
export const PLUGIN_NAME = 'dsh-livevoice'
export const LIVE_SAY_COMMAND = 'livevoice'
export const LIVE_HEAR_COMMAND = 'livevoice-hear'
export const BOOT_MARKER = '[my-plugins/dsh-livevoice] loaded'

export const LIVE_HTTP_PREFIX = '/plugins/dsh-livevoice'
export const LIVE_STATUS_PATH = `${LIVE_HTTP_PREFIX}/status`
export const LIVE_CALLS_PATH = `${LIVE_HTTP_PREFIX}/calls`
export const LIVE_EVENTS_PATH = `${LIVE_HTTP_PREFIX}/events`
export const LIVE_STOP_PATH = `${LIVE_HTTP_PREFIX}/stop`
export const LIVE_INPUT_ACTIVITY_PATH = `${LIVE_HTTP_PREFIX}/input-activity`
export const LIVE_MICROPHONE_SETTINGS_PATH = `${LIVE_HTTP_PREFIX}/microphone-settings`

export const LIVE_PROVIDER = 'openai-codex'
export const LIVE_ORIGINATOR = 'Codex Desktop'
export const OAUTH_STORE_FILENAME = '.dsh-oauth-auth.json'
export const OAUTH_PROXY_FILENAME = '.dsh-oauth-proxy.json'
export const LLM_CREDENTIAL_SCOPE = 'llm-pi-ai'
