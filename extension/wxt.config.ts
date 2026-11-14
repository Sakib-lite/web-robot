import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'web-robot',
    description: 'Autonomous browser agent — tell it a task, it drives your tabs.',
    permissions: ['sidePanel', 'storage', 'tabs', 'scripting', 'clipboardRead'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'web-robot',
    },
  },
});
