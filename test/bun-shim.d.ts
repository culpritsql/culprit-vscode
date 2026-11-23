declare module "bun:test" {
  export function describe(name: string, fn: () => void | Promise<void>): void;
  export function test(name: string, fn: () => void | Promise<void>, timeout?: number): void;
  export function it(name: string, fn: () => void | Promise<void>, timeout?: number): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  export const mock: {
    module(specifier: string, factory: () => Record<string, unknown>): Promise<void> | void;
    restore(): void;
  };
  export function expect<T = unknown>(actual: T): {
    toBe(expected: T): void;
    toEqual(expected: unknown): void;
    toContain(item: unknown): void;
    toMatch(pattern: RegExp | string): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeNull(): void;
    toBeDefined(): void;
    toBeGreaterThan(n: number): void;
    toBeGreaterThanOrEqual(n: number): void;
    toBeLessThan(n: number): void;
    toHaveLength(n: number): void;
    not: {
      toBe(expected: unknown): void;
      toContain(item: unknown): void;
      toMatch(pattern: RegExp | string): void;
      toBeNull(): void;
    };
  };
}
