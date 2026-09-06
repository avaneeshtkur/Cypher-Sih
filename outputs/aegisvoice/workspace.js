const views = {
  desk: ['Call desk', 'Listen to a scenario. See the request assessment change.'],
  review: ['Transcript lab', 'Test the rules on your own words, one turn at a time.'],
  verify: ['Voice check', 'Keep phrase completion, replay evidence and identity separate.'],
  data: ['Evidence library', 'Inspect the source records and limits behind the results.'],
  attack: ['Attack lab', 'Compare four delivery paths using rolling signal evidence and explicit uncertainty.']
};

export function openView(name) {
  if (!Object.hasOwn(views, name)) throw new Error(`Unknown workspace: ${name}`);
  for (const panel of document.querySelectorAll('[data-workspace]')) {
    panel.hidden = panel.dataset.workspace !== name;
  }
  for (const link of document.querySelectorAll('[data-view]')) {
    if (link.dataset.view === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const [title, description] = views[name];
  document.getElementById('page-title').textContent = title;
  document.getElementById('page-description').textContent = description;
  document.title = `AegisVoice | ${title}`;
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  window.dispatchEvent(new CustomEvent('workspacechange', {detail:name}));
}

export function initWorkspace() {
  const navigate = () => {
    const name = location.hash.slice(1);
    if (Object.hasOwn(views, name)) openView(name);
  };
  window.addEventListener('hashchange', navigate);
  openView(Object.hasOwn(views, location.hash.slice(1)) ? location.hash.slice(1) : 'desk');
}
