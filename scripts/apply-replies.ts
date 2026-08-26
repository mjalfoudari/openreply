/**
 * Give every active campaign a fresh set of 10 public reply rows.
 *
 * Reads sheets as JSON on stdin (see the skill's rotate.py) and assigns one per
 * campaign. Refuses anything that would regress the two properties those rows are
 * carrying: exactly 10 rows, and every row pointing at the DM — a reply that does not
 * send people to their inbox is what left the DMs unread in the first place.
 */
import { prisma } from "@/lib/db/client";

const DM_TOKENS = ["الخاص", "الدايركت", "دايركت", "الرسايل"];

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  const sheets: string[][] = JSON.parse(await readStdin());

  for (const [i, sheet] of sheets.entries()) {
    if (sheet.length !== 10) throw new Error(`sheet ${i} has ${sheet.length} rows, expected 10`);
    const blind = sheet.filter((r) => !DM_TOKENS.some((t) => r.includes(t)));
    if (blind.length) throw new Error(`sheet ${i} has a row with no DM pointer: ${blind[0]}`);
  }

  const autos = await prisma.automation.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  if (autos.length > sheets.length) {
    throw new Error(`${autos.length} campaigns but only ${sheets.length} sheets — draw more`);
  }

  for (const [i, a] of autos.entries()) {
    await prisma.automation.update({
      where: { id: a.id },
      data: { publicReplyMessages: sheets[i] },
    });
  }

  const after = await prisma.automation.findMany({
    where: { isActive: true },
    select: { publicReplyMessages: true },
  });
  const distinct = new Set(after.map((a) => a.publicReplyMessages.join("|"))).size;
  console.log(
    `[rotate] ${new Date().toISOString()} rotated ${autos.length} campaigns, ${distinct} distinct sheets`
  );
  process.exit(0);
}

void main();
