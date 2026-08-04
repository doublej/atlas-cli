/** A single `atlas` subcommand. Registered in registry.ts, dispatched by atlas.ts. */
export interface Command {
	name: string;
	summary: string;
	run(args: string[]): Promise<void>;
}
