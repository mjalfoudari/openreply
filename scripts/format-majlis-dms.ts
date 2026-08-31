/**
 * Preview or apply the one-DM Majlis formatting migration.
 *
 * Default is read-only. Public comment replies are deliberately untouched.
 */
import assert from "node:assert/strict";
import { prisma } from "@/lib/db/client";
import { buildTrackedUrl } from "@/lib/tracking/message";

const OLD_BRIDGE =
  "إذا تبي تشوف الطريق كامل من الفكرة لين الستور، افتح خريطة الطريق — ومنها تختار العضوية أو الاستشارة إذا احتجت 🔥 {link}";
const FORMATTED_BRIDGE = `إذا تبي تكمل من الفكرة لين الستور، هذي خريطة الطريق 👇

{link}

إذا فادك اللي فوق، سوّ لي فولو 🙏`;
const BUTTON = "شوف خطوات تطبيقك 👇";
const META_TEMPLATE_LIMIT = 640;

export function formatMajlisDm(value: string) {
  if (value.endsWith(FORMATTED_BRIDGE)) return value;
  if (!value.endsWith(OLD_BRIDGE)) {
    throw new Error("refusing unfamiliar Majlis DM ending");
  }

  const next = `${value.slice(0, -OLD_BRIDGE.length).trimEnd()}\n\n${FORMATTED_BRIDGE}`;
  if ((next.match(/\{link\}/gu) ?? []).length !== 1) {
    throw new Error("formatted Majlis DM must contain exactly one {link}");
  }
  return next;
}

function check() {
  const original = `1) القيمة الأولى\n2) القيمة الثانية\n\n${OLD_BRIDGE}`;
  const formatted = formatMajlisDm(original);
  assert.match(formatted, /القيمة الثانية[\s\S]+هذي خريطة الطريق 👇\n\n\{link\}/u);
  assert.match(formatted, /\{link\}\n\nإذا فادك اللي فوق، سوّ لي فولو 🙏$/u);
  assert.ok(BUTTON.length <= 20);
  assert.equal(formatMajlisDm(formatted), formatted);
  assert.throws(() => formatMajlisDm("نص غير معروف {link}"));
  console.log("[format-majlis-dms] checks passed");
}

async function main() {
  if (process.argv.includes("--check")) return check();
  const apply = process.argv.includes("--apply");
  const unexpected = process.argv.slice(2).filter((arg) => arg !== "--apply");
  if (unexpected.length) throw new Error(`unknown argument: ${unexpected[0]}`);

  const campaigns = await prisma.automation.findMany({
    where: {
      isActive: true,
      trackedLinks: {
        some: { destinationUrl: { startsWith: "https://majlisalcode.com/dalil" } },
      },
    },
    select: {
      id: true,
      name: true,
      dmMessage: true,
      openingDmEnabled: true,
      requireFollow: true,
      trackedLinks: {
        select: { slug: true, destinationUrl: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (campaigns.length === 0) throw new Error("no active Majlis campaigns found");

  const changes = campaigns.map((campaign) => {
    if (campaign.trackedLinks.length !== 1) {
      throw new Error(`${campaign.name} has ${campaign.trackedLinks.length} tracked links`);
    }
    const link = campaign.trackedLinks[0];
    const destination = new URL(link.destinationUrl);
    if (destination.hostname !== "majlisalcode.com" || destination.pathname !== "/dalil") {
      throw new Error(`refusing unexpected destination for ${campaign.name}`);
    }

    const dmMessage = formatMajlisDm(campaign.dmMessage);
    const rendered = dmMessage.replace("{link}", buildTrackedUrl(link.slug));
    if (rendered.length > META_TEMPLATE_LIMIT) {
      throw new Error(`${campaign.name} renders to ${rendered.length}/${META_TEMPLATE_LIMIT} chars`);
    }

    return { ...campaign, dmMessage, renderedChars: rendered.length };
  });

  console.table(
    changes.map((campaign) => ({
      campaign: campaign.name,
      openingDm: campaign.openingDmEnabled ? "ON → OFF" : "OFF",
      followGate: campaign.requireFollow ? "ON → OFF" : "OFF",
      button: BUTTON,
      chars: campaign.renderedChars,
    }))
  );

  if (!apply) {
    console.log(`[format-majlis-dms] dry run only — ${changes.length} campaigns unchanged`);
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const campaign of changes) {
      await tx.automation.update({
        where: { id: campaign.id },
        data: {
          dmMessage: campaign.dmMessage,
          openingDmEnabled: false,
          openingDmMessage: null,
          openingDmButtonLabel: null,
          requireFollow: false,
          followPromptMessage: null,
          followPromptButtonLabel: null,
          linkButtonLabel: BUTTON,
        },
      });
    }
  }, { timeout: 30_000 });

  console.log(`[format-majlis-dms] updated ${changes.length} campaigns`);
}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
