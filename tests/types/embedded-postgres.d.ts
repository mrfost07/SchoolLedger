/**
 * Minimal ambient types for `embedded-postgres` (the package ships types with
 * an `exports` map that the project's classic `moduleResolution: "node"`
 * cannot resolve). Only the surface used by the test infra is declared.
 */
declare module 'embedded-postgres' {
  export interface EmbeddedPostgresOptions {
    databaseDir: string;
    user: string;
    password: string;
    port: number;
    persistent?: boolean;
  }

  export default class EmbeddedPostgres {
    constructor(options: EmbeddedPostgresOptions);
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    createDatabase(name: string): Promise<void>;
  }
}
