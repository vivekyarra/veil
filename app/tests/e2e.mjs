import { _electron as electron } from "playwright";
import { obsMock } from "./mocks.ts";
import { resolve, join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import AxeBuilder from "@axe-core/playwright";

const appDir = resolve(import.meta.dirname, "..");
const workspace = resolve(appDir, "..");
const data = join(workspace, "runtime/e2e-" + Date.now());
mkdirSync(data, { recursive: true });
mkdirSync(join(workspace, "docs/screenshots"), { recursive: true });
const env = { ...process.env, VEIL_DATA_DIR: data };
const portProbe = createServer();
await new Promise((r) => portProbe.listen(0, "127.0.0.1", r));
const localPort = portProbe.address().port;
await new Promise((r) => portProbe.close(r));
env.VEIL_PORT = String(localPort);
delete env.ELECTRON_RUN_AS_NODE;
const obs = await obsMock();
const desktop = await electron.launch({
  executablePath:
    process.env.VEIL_E2E_EXECUTABLE ??
    join(appDir, "node_modules/electron/dist/electron.exe"),
  args: process.env.VEIL_E2E_EXECUTABLE ? [] : [appDir],
  cwd: appDir,
  env,
  timeout: 60000,
});
let output = "";
let completed = false;
desktop.process().stdout?.on("data", (b) => {
  output += b.toString();
});
desktop.process().stderr?.on("data", (b) => {
  output += b.toString();
});
const checkpoint = (stage) => {
  writeFileSync(join(data, "stage.txt"), stage);
};
const planted = "Synthetic E2E Academy";
try {
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(30000);
  const documentationScreenshot = async (path) => {
    // Keep documentation captures visible on desktops that throttle occluded
    // windows. Functional assertions and measured latency budgets stay intact.
    await (
      await desktop.browserWindow(page)
    ).evaluate((window) => {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    });
    await page.screenshot({ path, timeout: 60000 });
  };
  await page
    .getByRole("heading", { name: "Keep your private life off-stream." })
    .waitFor();
  let ready = false;
  for (let attempt = 0; attempt < 720; attempt++) {
    const response = await page.evaluate(() => window.veil.command("snapshot"));
    if (response.ok && response.value.detector) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready)
    writeFileSync(
      join(data, "startup-snapshot.json"),
      JSON.stringify(
        await page.evaluate(() => window.veil.command("snapshot")),
      ),
    );
  assert.equal(ready, true, "Detector did not finish initialization");
  checkpoint("renderer loaded");
  const accessibility = [];
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (theme) => window.veil.command("settings", { theme }),
      theme,
    );
    await page.waitForTimeout(100);
    for (const name of [
      "Dashboard",
      "Never Show",
      "Incidents",
      "Pre-flight",
      "Rehearsal",
      "Settings",
      "Onboarding",
    ]) {
      await page.getByRole("button", { name, exact: true }).click();
      const result = await new AxeBuilder({ page })
        .setLegacyMode()
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      accessibility.push({
        theme,
        page: name,
        violations: result.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.map((n) => ({
            target: n.target,
            summary: n.failureSummary,
          })),
        })),
      });
    }
  }
  writeFileSync(
    join(workspace, "docs/accessibility.json"),
    JSON.stringify(accessibility, null, 2),
  );
  assert.ok(
    accessibility.every((p) => p.violations.length === 0),
    "Automated accessibility violations: inspect docs/accessibility.json",
  );
  await page.evaluate(() => window.veil.command("settings", { theme: "dark" }));
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await documentationScreenshot(
    join(workspace, "docs/screenshots/dashboard.png"),
  );
  await page.getByRole("button", { name: "Onboarding", exact: true }).click();
  checkpoint("onboarding opened");
  await page.getByLabel("Local WebSocket URL").fill(obs.url);
  await page.getByLabel("OBS password").fill("synthetic");
  await page.getByRole("button", { name: "Connect & inspect OBS" }).click();
  checkpoint("connect clicked");
  await page.getByRole("checkbox", { name: "Live", exact: true }).check();
  await page.getByRole("button", { name: "Add filters & sync audio" }).click();
  await page.waitForFunction(
    () => document.querySelector("[role=status]")?.textContent === "Done",
  );
  assert.equal(obs.offsets.Mic, 775);
  await page.getByRole("button", { name: "Never Show", exact: true }).click();
  await page.getByLabel("Category").selectOption("school");
  await page.getByLabel("Private term", { exact: true }).fill(planted);
  await page.getByRole("button", { name: "Add to vault", exact: true }).click();
  await page.getByRole("button", { name: "Reveal school" }).waitFor();
  assert.equal(await page.getByText(planted, { exact: true }).count(), 0);
  await page.getByLabel("6–12 digit PIN").fill("123456");
  await page.getByRole("button", { name: "Set PIN", exact: true }).click();
  await page.getByLabel("6–12 digit PIN").fill("123456");
  await page.getByRole("button", { name: "Unlock vault", exact: true }).click();
  await page.getByRole("button", { name: "Reveal school" }).click();
  await page.getByText(planted, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Delete school" }).click();
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await page.getByRole("button", { name: /PANIC/ }).click();
  await page.getByRole("alertdialog").waitFor();
  await page.keyboard.press("Shift+Tab");
  await page
    .getByRole("button", { name: "Allow action", exact: true })
    .evaluate((button) => {
      if (button !== document.activeElement)
        throw new Error("Approval focus escaped modal");
    });
  await page.keyboard.press("Tab");
  await page.getByRole("button", { name: "No, keep it off" }).click();
  await page.getByRole("button", { name: /Incidents/ }).click();
  await page.getByRole("button", { name: /#1/ }).click();
  await page.getByRole("heading", { name: "Incident #1" }).waitFor();
  await documentationScreenshot(
    join(workspace, "docs/screenshots/incident.png"),
  );
  const exports = {
    md: join(data, "report.md"),
    pdf: join(data, "report.pdf"),
    diagnostics: join(data, "diagnostics.json"),
  };
  await desktop.evaluate(({ dialog }, paths) => {
    dialog.showSaveDialog = async (_window, options) => ({
      canceled: false,
      filePath: options.defaultPath.endsWith(".json")
        ? paths.diagnostics
        : options.defaultPath.endsWith(".pdf")
          ? paths.pdf
          : paths.md,
    });
  }, exports);
  for (const format of ["md", "pdf"]) {
    const result = await page.evaluate(
      ({ format }) => window.veil.command("export", { id: 1, format }),
      { format },
    );
    assert.equal(result.ok, true);
  }
  assert.equal(readFileSync(exports.md, "utf8").includes(planted), false);
  assert.equal(readFileSync(exports.pdf).subarray(0, 5).toString(), "%PDF-");
  const diagnostics = await page.evaluate(() =>
    window.veil.command("logs-export"),
  );
  assert.equal(diagnostics.ok, true);
  const diagnosticText = readFileSync(exports.diagnostics, "utf8");
  assert.equal(diagnosticText.includes(planted), false);
  assert.equal(diagnosticText.includes("token"), false);
  assert.equal(JSON.parse(diagnosticText).configuration.delay, 750);
  writeFileSync(
    join(data, "state-before-scan.json"),
    JSON.stringify(
      await page.evaluate(() => window.veil.command("snapshot")),
      null,
      2,
    ),
  );
  const sourceResult = await page.evaluate(() =>
    window.veil.command("source-scan"),
  );
  assert.equal(sourceResult.ok, true, sourceResult.error);
  assert.ok(sourceResult.value[0].kinds.includes("email"));
  const solidPixels = await desktop.evaluate(({ nativeImage }, image) => {
    const pixels = nativeImage.createFromDataURL(image).toBitmap();
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i] === 24 && pixels[i + 1] === 24 && pixels[i + 2] === 24)
        count++;
    return count;
  }, sourceResult.value[0].image);
  assert.ok(solidPixels > 20, "Pre-flight thumbnail was not solid-masked");
  await page.getByRole("button", { name: "Rehearsal", exact: true }).click();
  await page.getByRole("button", { name: "Email inbox ↗" }).click();
  await page.locator(".scan-result").waitFor({ timeout: 90000 });
  assert.match(
    await page.locator(".scan-result").innerText(),
    /Regions\s+[1-9]/,
  );
  const scenarioMeasurements = [];
  for (const kind of ["dm", "terminal", "form"]) {
    const result = await page.evaluate(
      (kind) => window.veil.command("scenario", { kind }),
      kind,
    );
    assert.equal(result.ok, true);
    assert.ok(
      result.value.detections.length > 0,
      kind + " had no detected region",
    );
    scenarioMeasurements.push({
      kind,
      processed_ms: result.value.processed_ms,
      late: result.value.late,
      masked: result.value.masked,
      fullHold: result.value.fullHold,
    });
  }
  const snapshot = await page.evaluate(() => window.veil.command("snapshot"));
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.detector, true);
  assert.equal(
    output.includes(planted),
    false,
    "Planted vault data appeared in process logs",
  );
  writeFileSync(
    join(workspace, "docs/e2e-evidence.json"),
    JSON.stringify(
      {
        executed: true,
        packaged: Boolean(process.env.VEIL_E2E_EXECUTABLE),
        platform: process.platform,
        checks: [
          "real Electron renderer",
          "OBS v5 loopback onboarding",
          "audio offset apply",
          "vault add/PIN/reveal/delete",
          "panic and default-no approval",
          "incident detail",
          "actual OCR rehearsal",
          "Markdown and actual PDF export",
          "source-by-source OCR and pixel-verified masked pre-flight thumbnail",
          "planted-text process-log scan",
          "seven routes in both themes: automated WCAG A/AA audit",
          "approval keyboard focus stays inside modal",
          "metadata diagnostics export excludes planted text and tokens",
        ],
        rehearsal_native_obs_output_verified: false,
        scenarioMeasurements,
      },
      null,
      2,
    ),
  );
  completed = true;
} catch (error) {
  writeFileSync(join(data, "failure.txt"), String(error));
  writeFileSync(join(data, "process-output.txt"), output);
  throw error;
} finally {
  const process = desktop.process();
  const exited =
    process.exitCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => process.once("exit", resolve));
  // Playwright must detach the Node inspector as well as request app.quit().
  // Otherwise Electron can wait for its debugger after application cleanup.
  const closed = desktop.close();
  let timeout;
  try {
    await Promise.race([
      Promise.all([closed, exited]),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Electron clean quit timeout")),
          30000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(
    JSON.parse(readFileSync(join(data, "shutdown.json"), "utf8")).stage,
    "clean",
  );
  assert.equal(
    obs.offsets.Mic,
    25,
    "Audio offset did not restore on clean quit",
  );
  assert.equal(obs.offsets.Desktop, -10);
  await obs.close();
  if (completed) {
    const evidencePath = join(workspace, "docs/e2e-evidence.json");
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          ...JSON.parse(readFileSync(evidencePath, "utf8")),
          passed: true,
          clean_exit_audio_restored: true,
          completed_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }
}
