import { arch, hostname, platform } from 'os';
import { c, sleep, visibleLength } from './terminal';

const BOX_WIDTH = 60;
const BAR_WIDTH = 50;
const BAR_FRAMES = 14;

const WORDMARK = [
  `${c.cyan}▄▀█ █▀▀ █▀▀ █▄ █ ▀█▀${c.reset}   ${c.cyan}▀█▀ █ █ █▄ █ █▄ █ █▀▀ █  ${c.reset}`,
  `${c.cyan}█▀█ █▄█ ██▄ █ ▀█  █${c.reset}    ${c.cyan} █  █▄█ █ ▀█ █ ▀█ ██▄ █▄▄${c.reset}`,
];

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

async function animateConnectingBar(): Promise<void> {
  for (let frame = 0; frame <= BAR_FRAMES; frame++) {
    const filled = Math.round((frame / BAR_FRAMES) * BAR_WIDTH);
    process.stdout.write(
      `\r      ${c.cyan}◇${c.reset} ${c.cyan}${'═'.repeat(filled)}${c.reset}${c.gray}${'─'.repeat(BAR_WIDTH - filled)}${c.reset}  `,
    );
    await sleep(20);
  }
  process.stdout.write(`\r      ${c.cyan}◇ ${'═'.repeat(BAR_WIDTH)} ◆${c.reset}  \n`);
  await sleep(120);
}

export interface BannerDetails {
  tunnelId: string;
  apiUrl: string;
  capabilities: string[];
  version: string;
}

export async function printStartupBanner({
  tunnelId,
  apiUrl,
  capabilities,
  version,
}: BannerDetails): Promise<void> {
  console.log('');
  for (const line of WORDMARK) console.log(`      ${line}`);
  console.log('');

  await animateConnectingBar();

  const row = (content: string) => {
    const pad = Math.max(0, BOX_WIDTH - visibleLength(content));
    console.log(`  ${c.gray}│${c.reset}${content}${' '.repeat(pad)}${c.gray}│${c.reset}`);
  };
  const blank = () => row('');

  const titleLeft =`   ${c.cyan}◆${c.reset}  ${c.bold}${c.white}Agent Tunnel${c.reset}`;
  const titleRight = `${c.dim}v${version}${c.reset}   `;
  const titlePad = Math.max(1, BOX_WIDTH - visibleLength(titleLeft) - visibleLength(titleRight));

  // An empty capability set means the tunnel can connect but do nothing, so it
  // is stated outright rather than rendered as an empty gap.
  const capabilityRow =
    capabilities.length > 0
      ? capabilities.map((name) => `${c.green}●${c.reset} ${c.white}${name}${c.reset}`).join('   ')
      : `${c.yellow}none — this tunnel cannot act${c.reset}`;

  const brand = 'created by kortix';

  console.log('');
  console.log(`  ${c.gray}╭${'─'.repeat(BOX_WIDTH)}╮${c.reset}`);
  blank();
  row(`${titleLeft}${' '.repeat(titlePad)}${titleRight}`);
  row(`   ${c.dim}Bridge between AI agents & local machines${c.reset}`);
  blank();
  row(`   ${c.dim}tunnel${c.reset}    ${c.white}${truncate(tunnelId, 40)}${c.reset}`);
  row(`   ${c.dim}relay${c.reset}     ${c.white}${truncate(apiUrl, 40)}${c.reset}`);
  row(`   ${c.dim}machine${c.reset}   ${c.white}${truncate(hostname(), 28)}${c.reset} ${c.dim}(${platform()} ${arch()})${c.reset}`);
  row(`   ${c.dim}access${c.reset}    ${capabilityRow}`);
  blank();
  console.log(
    `  ${c.gray}╰${'─'.repeat(BOX_WIDTH - brand.length - 3)} ${c.dim}created by ${c.cyan}kortix${c.reset} ${c.gray}─╯${c.reset}`,
  );
  console.log('');
}
