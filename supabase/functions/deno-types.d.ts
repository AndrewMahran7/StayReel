// Minimal Deno global type shim for VS Code TypeScript language service.
// The real Deno runtime supplies these; this file just prevents TS2304
// "Cannot find name 'Deno'" in the editor.

declare namespace Deno {
  export interface ServeOptions {
    port?: number;
    hostname?: string;
    onListen?: (localAddr: { hostname: string; port: number }) => void;
  }

  export function serve(
    handler: (req: Request) => Response | Promise<Response>,
    options?: ServeOptions,
  ): void;

  export const env: {
    get(key: string): string | undefined;
    toObject(): Record<string, string>;
  };

  export interface TestDefinition {
    fn: () => void | Promise<void>;
    name: string;
    only?: boolean;
    ignore?: boolean;
  }

  export function test(name: string, fn: () => void | Promise<void>): void;
  export function test(t: TestDefinition): void;
}
