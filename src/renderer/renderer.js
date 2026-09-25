'use strict';

// Builds one card per registered tool (main.js's buildToolRegistry())
// -- nothing here is specific to any one tool's identity, so adding a
// new tool on the main-process side is enough for it to show up here
// with no renderer changes needed.
async function init() {
  const tools = await window.utilityAPI.listTools();
  const list = document.getElementById('tool-list');

  for (const tool of tools) {
    const card = document.createElement('div');
    card.className = 'tool-card';

    const info = document.createElement('div');
    info.className = 'tool-info';

    const title = document.createElement('div');
    title.className = 'tool-title';
    title.textContent = tool.label;
    info.appendChild(title);

    if (tool.description) {
      const desc = document.createElement('div');
      desc.className = 'tool-description';
      desc.textContent = tool.description;
      info.appendChild(desc);
    }

    card.appendChild(info);

    const runBtn = document.createElement('button');
    runBtn.className = 'tool-run-btn';
    // Window-opening tools (e.g. USB Wiper) get their own window
    // rather than running in place, so "Open" reads more accurately
    // than "Run" for those.
    runBtn.textContent = tool.kind === 'window' ? 'Open' : 'Run';
    runBtn.onclick = () => window.utilityAPI.invokeTool(tool.id);
    card.appendChild(runBtn);

    list.appendChild(card);
  }
}

init();
