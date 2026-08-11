// The atlas-picker splash art, shared with `atlas help`.
// Transcribed from atlas-picker/src/splash.rs — edit both if the art changes.
const LOGOS: string[][] = [
	[
		"         __  __                       _      __            ",
		"  ____ _/ /_/ /___ ______      ____  (_)____/ /_____  _____",
		" / __ `/ __/ / __ `/ ___/_____/ __ \\/ / ___/ //_/ _ \\/ ___/",
		"/ /_/ / /_/ / /_/ (__  )_____/ /_/ / / /__/ ,< /  __/ /    ",
		"\\__,_/\\__/_/\\__,_/____/     / .___/_/\\___/_/|_|\\___/_/     ",
		"                           /_/                              "
	],
	[
		"       |   |                       _)      |              ",
		"  _` | __| |  _` |  __|       __ \\  |  __| |  /  _ \\  __|",
		" (   | |   | (   |\\__ \\_____| |   | | (      <   __/ |   ",
		"\\__,_|\\__|_|\\__,_|____/       .__/ _|\\___|_|\\_\\___|_|   ",
		"                             _|                           "
	],
	[
		"       __  __                 _     __          ",
		" ___ _/ /_/ /__ ___________  (_)___/ /_____ ____",
		"/ _ `/ __/ / _ `(_-<___/ _ \\/ / __/  '_/ -_) __/",
		"\\_,_/\\__/_/\\_,_/___/  / .__/_/\\__/_/\\_\\\\__/_/   ",
		"                     /_/                        "
	],
	[
		"        tt    lll                              iii        kk                   ",
		"  aa aa tt    lll   aa aa  sss         pp pp         cccc kk  kk   eee  rr rr  ",
		" aa aaa tttt  lll  aa aaa s     _____  ppp  pp iii cc     kkkkk  ee   e rrr  r ",
		"aa  aaa tt    lll aa  aaa  sss         pppppp  iii cc     kk kk  eeeee  rr     ",
		" aaa aa  tttt lll  aaa aa     s        pp      iii  ccccc kk  kk  eeeee rr     ",
		"                           sss         pp                                      "
	]
];

const SUBTITLE = 'find. pick. go.';

/** The banner: one of the picker's logos (rotating, as the picker does) + its subtitle. */
export function banner(): string {
	const logo = LOGOS[Date.now() % LOGOS.length];
	return [...logo, '', SUBTITLE].join('\n');
}
