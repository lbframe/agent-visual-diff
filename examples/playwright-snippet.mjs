import { test, expect } from '@playwright/test';
import { comparePngFiles } from '../src/compare.js';

test('homepage visual evidence', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('http://localhost:3000');
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
  await page.screenshot({ path: 'artifacts/current/home.png', animations: 'disabled' });

  const report = comparePngFiles({
    expected: 'references/home.png',
    actual: 'artifacts/current/home.png',
    diffPng: 'artifacts/diffs/home.png',
    section: 'home'
  });

  console.log(JSON.stringify(report));
  expect(report.diffRatio).toBeLessThanOrEqual(0.005);
});
