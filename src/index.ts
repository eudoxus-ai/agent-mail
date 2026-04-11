#!/usr/bin/env node

const command = process.argv[2];

switch (command) {
  case 'add-account': {
    const { addAccount } = await import('./cli/add-account.js');
    await addAccount();
    break;
  }
  case 'serve': {
    const { serve } = await import('./cli/serve.js');
    await serve();
    break;
  }
  case 'reviewer': {
    const { startReviewer } = await import('./cli/reviewer.js');
    const port = process.argv[3] ? parseInt(process.argv[3]) : undefined;
    await startReviewer(port);
    break;
  }
  case 'config': {
    const { printConfig } = await import('./cli/config.js');
    printConfig();
    break;
  }
  case 'install': {
    const { installConfig } = await import('./cli/config.js');
    await installConfig();
    break;
  }
  default:
    console.error('Usage: agent-mail <add-account|serve|reviewer [port]|config|install>');
    process.exit(1);
}
