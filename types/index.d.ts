export type ActiveStep = number

declare module 'claude-code' {
  interface PluginState {
    'project-map': { active: ActiveStep }
  }
}
