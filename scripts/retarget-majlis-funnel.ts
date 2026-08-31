/**
 * Preview or apply the one-time Majlis Instagram funnel migration.
 *
 * Default is read-only. Pass --apply only after the active DM copy has been approved.
 */
import assert from "node:assert/strict";
import { prisma } from "@/lib/db/client";

const CAMPAIGN_IDS = [
  "cmt98h6ru0000at016n722hma",
  "cmt70c16y000004l5prp46m27",
  "cmt5vogoe000004if5o4yovpz",
  "cmt5n86ve000704jtg7qff8ra",
  "cmt5k6f0u000c04l3m358ezmf",
  "cmt4v3j0p000404l9s4n5f23v",
  "cmt3hk4an001i04kzfaf1kk9g",
  "cmt3hfsht000f04lchofe3scm",
  "cmt3hbjg0001f04kzmd0mui7s",
  "cmt3h6bau000b04lceyqekqs2",
  "cmt3h0wre000804lc8dbx7fzy",
  "cmt3dk17a000g04jwqxepjo38",
  "cmt3diefd000304kzjpym9rza",
  "cmt3cquit000304jwmipe0kki",
  "cmt3clwpn001004jimo2ejg7k",
  "cmt39wy88000m04joyucyev15",
  "cmt39n5x7000504jo4zexpspi",
  "cmt39iw4w000h04jimedqd42q",
  "cmt39i89z000f04jiqtpf0d4h",
  "cmt399uhk000904ji3wzu8gmk",
  "cmt1xu1d3000304iees3hpuf4",
  "cmt1enf04000004l2st069r8t",
  "cmt1emarj000604kwy9o2blx9",
] as const;

const BUTTON = "شوف خطوات تطبيقك 👇";
const BRIDGE =
  "إذا تبي تشوف الطريق كامل من الفكرة لين الستور، افتح خريطة الطريق — ومنها تختار العضوية أو الاستشارة إذا احتجت 🔥 {link}";
const FOLLOW_UP =
  "يعطيك العافية 🙏 شفت خريطة الطريق؟ إذا تبي تبني بنفسك اختَر العضوية، وإذا عندك قرار محدد اختَر الاستشارة. الاثنين واضحين هنا: majlisalcode.com/dalil 🔥";

const OLD_PITCHES = [
  "الجدول كامل بالحدود والروابط بالمجتمع 🔥 {link}",
  "وحياك في المجتمع الرابط تحت {link}",
  "كل خطوة مشروحة بالمجتمع 🔥 {link}",
  "حياك بالمجتمع وتلقاها تحت الرابط 🔥 {link}",
  "التحديثات أول بأول بالمجتمع 🔥 {link}",
  "الأمثلة كاملة لكل وحدة بالمجتمع 🔥 {link}",
  "القصة والأدوات بمجتمعنا {link}",
  "الإعداد خطوة بخطوة بالمجتمع 🔥 {link}",
  "التفاصيل بمجتمعنا {link}",
  "التفاصيل والأدوات بمجتمعنا {link}",
  "الدرس كامل بالمجتمع 🔥 {link}",
  "شلون بنيتها خطوة بخطوة بالمجتمع 🔥 {link}",
  "الترتيب والتفاصيل بالمجتمع 🔥 {link}",
  "حطيت لك رابط الموديل وموارد بمجتمعنا تحت {link}",
  "التفاصيل والدكيومنتيشن كاملة عند أنثروبيك، وحطيت لك ملخص وموارد إضافية بمجتمعنا تحت {link}",
  "حطيت لك تفاصيل أكثر وموارد بمجتمعنا تحت {link}",
] as const;

const CORE_OVERRIDES: Partial<Record<(typeof CAMPAIGN_IDS)[number], string>> = {
  cmt5n86ve000704jtg7qff8ra: `خطة التوزيع بأربع خطوات:

1) حدّد شخص واحد ومشكلة وحدة قبل ما تبني
2) ورّه صورة أو نموذج بسيط وخذ منه اعتراضاته
3) اجمع أول قائمة مهتمين من نفس المكان اللي لقيتهم فيه
4) ابنِ أصغر نسخة، عطها لأول عشرة، وخل استخدامهم يحدد شنو تبني بعدها`,
  cmt3h0wre000804lc8dbx7fzy:
    "جربت أكثر من 40 أداة، والقاعدة اللي بقت عندي: اختَر ستاك تقدر تشحن فيه بروحك، مو الأكثر ترند. Shorebird للتحديثات السريعة، وGemini للشغل اللي يحتاج سياق طويل. لا تبدّل أداة إلا إذا وقفتك عن الشحن.",
};

export function retargetUrl(value: string) {
  const url = new URL(value);
  if (url.hostname !== "majlisalcode.com" || url.pathname !== "/") {
    throw new Error(`refusing unexpected campaign destination: ${value}`);
  }
  url.pathname = "/dalil";
  return url.toString();
}

export function retargetMessage(
  campaignId: (typeof CAMPAIGN_IDS)[number],
  value: string,
) {
  const override = CORE_OVERRIDES[campaignId];
  const pitch = OLD_PITCHES.find((candidate) => value.endsWith(candidate));
  if (!override && !pitch) {
    throw new Error(`refusing unfamiliar DM copy for ${campaignId}`);
  }

  const core = override ?? value.slice(0, -pitch!.length).trimEnd();
  const next = `${core}\n\n${BRIDGE}`;
  if ((next.match(/\{link\}/gu) ?? []).length !== 1 || next.length > 1000) {
    throw new Error(`invalid rewritten DM for ${campaignId}`);
  }
  return next;
}

function check() {
  assert.equal(
    retargetUrl(
      "https://majlisalcode.com/?utm_source=instagram&utm_content=prompt-1",
    ),
    "https://majlisalcode.com/dalil?utm_source=instagram&utm_content=prompt-1",
  );
  assert.match(
    retargetMessage(CAMPAIGN_IDS[0], `القيمة هنا\n\n${OLD_PITCHES[0]}`),
    /القيمة هنا[\s\S]+خريطة الطريق[\s\S]+\{link\}$/u,
  );
  assert.throws(() => retargetUrl("https://example.com/"));
  assert.throws(() => retargetMessage(CAMPAIGN_IDS[0], "نص غير متوقع {link}"));
  console.log("[majlis-funnel] checks passed");
}

async function main() {
  if (process.argv.includes("--check")) return check();
  const apply = process.argv.includes("--apply");
  const unexpected = process.argv.slice(2).filter((arg) => arg !== "--apply");
  if (unexpected.length) throw new Error(`unknown argument: ${unexpected[0]}`);

  const campaigns = await prisma.automation.findMany({
    where: { id: { in: [...CAMPAIGN_IDS] } },
    select: {
      id: true,
      name: true,
      isActive: true,
      dmMessage: true,
      followUpDelayMinutes: true,
      trackedLinks: {
        select: { id: true, destinationUrl: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (campaigns.length !== CAMPAIGN_IDS.length) {
    throw new Error(`found ${campaigns.length}/${CAMPAIGN_IDS.length} target campaigns`);
  }

  const changes = campaigns.map((campaign) => {
    if (!campaign.isActive) throw new Error(`${campaign.name} is no longer active`);
    if (campaign.trackedLinks.length !== 1) {
      throw new Error(`${campaign.name} has ${campaign.trackedLinks.length} links`);
    }
    return {
      ...campaign,
      dmMessage: retargetMessage(
        campaign.id as (typeof CAMPAIGN_IDS)[number],
        campaign.dmMessage,
      ),
      destinationUrl: retargetUrl(campaign.trackedLinks[0].destinationUrl),
    };
  });

  console.table(
    changes.map((campaign) => ({
      campaign: campaign.name,
      destination: campaign.destinationUrl,
      button: BUTTON,
      followUpDelay: campaign.followUpDelayMinutes || 1440,
    })),
  );

  if (!apply) {
    console.log(`[majlis-funnel] dry run only — ${changes.length} campaigns unchanged`);
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const campaign of changes) {
      await tx.automation.update({
        where: { id: campaign.id },
        data: {
          dmMessage: campaign.dmMessage,
          linkButtonLabel: BUTTON,
          followUpEnabled: true,
          followUpMessage: FOLLOW_UP,
          followUpDelayMinutes: campaign.followUpDelayMinutes || 1440,
        },
      });
      await tx.trackedLink.update({
        where: { id: campaign.trackedLinks[0].id },
        data: { destinationUrl: campaign.destinationUrl },
      });
    }
  }, { timeout: 30_000 });

  console.log(`[majlis-funnel] updated ${changes.length} campaigns`);
}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
