/** A single `atlas` subcommand. Registered in registry.ts, dispatched by atlas.ts. */
export interface Command {
	name: string;
	summary: string;
	/** Printed on `-h`/`--help`; falls back to the summary. */
	usage?: string;
	run(args: string[]): Promise<void>;
}
