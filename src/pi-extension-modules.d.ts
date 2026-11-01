/* eslint-disable @typescript-eslint/no-explicit-any */
// Pi supplies these modules to extensions when it loads them; gnhf only needs
// their shapes to type-check extensions/gnhf-finish.ts.
declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    registerTool(tool: unknown): void;
    on(event: string, handler: (event: any) => unknown): void;
    setActiveTools(names: string[]): void;
  }
  export function defineTool<T extends object>(tool: T): T;
}
declare module "typebox" {
  export const Type: { Unsafe(schema: unknown): unknown };
}
