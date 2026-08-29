> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Claude Code settings reference

> Complete reference for every Claude Code settings.json key: where each one goes, its type and default, and a paste-ready example, with an index of every key.

export const BackToIndex = ({href = '#all-settings', label = 'Back to index'}) => {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > window.innerHeight);
    onScroll();
    window.addEventListener('scroll', onScroll, {
      passive: true
    });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return <div className="not-prose">
      <style>{`
        .bti-btn {
          position: fixed; right: 20px; bottom: 20px; z-index: 40;
          display: inline-flex; align-items: center; gap: 6px;
          padding: 8px 12px; border-radius: 999px;
          font-size: 13px; font-weight: 500; line-height: 1; text-decoration: none;
          color: #1f1f1f; background: #ffffff; border: 1px solid #d9d9d9;
          box-shadow: 0 2px 8px rgba(0,0,0,0.12);
          opacity: 0; pointer-events: none; transform: translateY(6px);
          transition: opacity 160ms ease, transform 160ms ease;
        }
        .bti-btn.bti-show { opacity: 1; pointer-events: auto; transform: translateY(0); }
        .bti-btn:hover { border-color: #b3b3b3; }
        .dark .bti-btn { color: #ececec; background: #1e1e1e; border-color: #3a3a3a; box-shadow: 0 2px 8px rgba(0,0,0,0.5); }
        .dark .bti-btn:hover { border-color: #5a5a5a; }
        @media (max-width: 1279px) { .bti-btn { bottom: 112px; } }
        @media print { .bti-btn { display: none; } }
      `}</style>
      <a className={'bti-btn' + (show ? ' bti-show' : '')} href={href} aria-hidden={!show} tabIndex={show ? 0 : -1}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
        {label}
      </a>
    </div>;
};

export const ReferenceFilter = ({placeholder, noun, facets, facetOrder, columnHelp, children}) => {
  const useLive = init => {
    const [v, setV] = useState(init);
    const ref = useRef(init);
    return [v, ref, x => {
      ref.current = x;
      setV(x);
    }];
  };
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const plural = s => s.endsWith('y') ? s.slice(0, -1) + 'ies' : s + 's';
  const facetNames = facets || ['category', 'topic', 'scope', 'where'];
  const orderOf = {};
  Object.keys(facetOrder || ({})).forEach(k => {
    orderOf[k] = facetOrder[k].map(x => String(x).toLowerCase());
  });
  const rankIn = (col, v) => {
    const list = orderOf[col];
    if (!list) return -1;
    const i = list.indexOf(String(v).toLowerCase());
    return i < 0 ? list.length : i;
  };
  const cmpValues = col => (a, b) => {
    const ra = rankIn(col, a);
    const rb = rankIn(col, b);
    if (ra !== rb) return ra - rb;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const help = columnHelp || ({});
  const FIRST_COL_HELP = 'Click an entry to open it.';
  const optionLabel = (f, c) => c === 'All' ? 'All ' + plural(f.label.toLowerCase()) : c;
  const nounText = noun || 'entries';
  const placeholderText = placeholder || 'Filter this reference';
  const rootRef = useRef(null);
  const tablesRef = useRef(null);
  const searchRef = useRef(null);
  const menuRef = useRef({});
  const [q, qRef, setQ] = useLive('');
  const [sel, selRef, setSel] = useLive({});
  const [sortBy, sortRef, setSortBy] = useLive(null);
  const [menuOpen, menuOpenRef, setMenu] = useLive(null);
  const [facetList, setFacetList] = useState([]);
  const [firstHead, setFirstHead] = useState('');
  const [counts, setCounts] = useState({
    shown: 0,
    total: 0
  });
  const [disabled, setDisabled] = useState(false);
  const menuBtn = name => menuRef.current[name] ? menuRef.current[name].querySelector(':scope > button') : null;
  const menuList = name => menuRef.current[name] ? menuRef.current[name].querySelector('[role="listbox"]') : null;
  const closeMenu = name => {
    setMenu(null);
    const btn = menuBtn(name);
    if (btn) btn.focus();
  };
  const focusSelected = name => {
    const list = menuList(name);
    if (!list) return;
    const btn = list.querySelector('button[aria-selected="true"]') || list.querySelector('button');
    if (btn) btn.focus();
  };
  const setFacet = (name, value) => {
    setSel(Object.assign({}, selRef.current, {
      [name]: value
    }));
    apply(qRef.current);
    closeMenu(name);
  };
  const sortTables = by => {
    (tablesRef.current || []).forEach(tab => {
      const t = tab.el;
      const idx = tab.heads.indexOf(by);
      const body = t.querySelector('tbody');
      if (idx < 0 || !body) return;
      const rows = [...body.querySelectorAll('tr')];
      const keyOf = r => r.children[idx] ? r.children[idx].textContent.trim().toLowerCase() : '';
      const cmp = cmpValues(by);
      rows.map((r, i) => ({
        r,
        i: Number(r.dataset.sfIndex !== undefined ? r.dataset.sfIndex : i),
        k: keyOf(r)
      })).sort((a, b) => cmp(a.k, b.k) || a.i - b.i).forEach(x => body.appendChild(x.r));
      [...t.querySelectorAll('thead th')].forEach((h, i) => {
        const sortable = tab.heads[i] === tab.heads[0] || facetNames.indexOf(tab.heads[i]) > -1;
        if (sortable) h.setAttribute('aria-sort', i === idx ? 'ascending' : 'none'); else h.removeAttribute('aria-sort');
      });
    });
  };
  const scan = () => {
    const tables = [];
    let el = rootRef.current ? rootRef.current.nextElementSibling : null;
    while (el) {
      if (el.tagName === 'H2' || el.querySelector(':scope > h2')) break;
      const found = el.tagName === 'TABLE' ? [el] : [...el.querySelectorAll('table')];
      found.forEach(t => {
        const headCells = [...t.querySelectorAll('thead th, thead td')];
        const heads = headCells.map(h => h.textContent.trim().toLowerCase());
        if (heads.length === 0) return;
        const facetIdx = {};
        heads.forEach((h, i) => {
          if (facetNames.indexOf(h) > -1) facetIdx[h] = i;
        });
        if (!t.dataset.sfDecorated) {
          t.dataset.sfDecorated = '1';
          headCells.forEach((h, i) => {
            const text = i === 0 ? help[heads[0]] || FIRST_COL_HELP : help[heads[i]];
            if (text) h.title = text;
          });
        }
        const rows = [...t.querySelectorAll('tbody tr')].map((r, i) => {
          if (r.dataset.sfIndex === undefined) r.dataset.sfIndex = String(i);
          const cells = r.querySelectorAll('td');
          const fv = {};
          Object.keys(facetIdx).forEach(h => {
            fv[h] = cells[facetIdx[h]] ? cells[facetIdx[h]].textContent.trim() : '';
          });
          return {
            el: r,
            text: [...cells].map(c => c.textContent).join(' ').toLowerCase(),
            facets: fv,
            anchors: [...r.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute('href').slice(1)),
            ids: [...r.querySelectorAll('[id]')].map(n => n.id)
          };
        });
        tables.push({
          el: t,
          box: t.closest('[data-table-wrapper]') || t,
          rows,
          heads
        });
      });
      el = el.nextElementSibling;
    }
    tablesRef.current = tables;
    if (sortRef.current) sortTables(sortRef.current);
    return tables;
  };
  const apply = query => {
    let tables = tablesRef.current || scan();
    if (tables.some(t => !t.el.isConnected)) tables = scan();
    const needle = query.trim().toLowerCase();
    const sel = selRef.current;
    const activeFacets = Object.keys(sel).filter(h => sel[h] && sel[h] !== 'All');
    const show = (el, on) => {
      const want = on ? '' : 'none';
      if (el.style.display !== want) el.style.display = want;
    };
    let total = 0;
    let shown = 0;
    const visibleTargets = new Set();
    tables.forEach(t => {
      let tableVisible = 0;
      t.rows.forEach(row => {
        total += 1;
        const catOk = activeFacets.every(h => {
          const v = row.facets[h];
          return v === sel[h] || v === '' || v === undefined;
        });
        const match = catOk && (needle === '' || row.text.includes(needle));
        show(row.el, match);
        if (match) {
          tableVisible += 1;
          row.anchors.forEach(a => visibleTargets.add(a));
        }
      });
      show(t.box, !(t.rows.length > 0 && tableVisible === 0));
      shown += tableVisible;
    });
    if (shown < total && visibleTargets.size > 0) {
      tables.forEach(t => {
        t.rows.forEach(row => {
          if (row.el.style.display === 'none' && row.ids.some(id => visibleTargets.has(id))) {
            show(row.el, true);
            show(t.box, true);
            shown += 1;
          }
        });
      });
    }
    setCounts({
      shown,
      total
    });
    return total;
  };
  const deriveFacets = tables => {
    const seen = {};
    tables.forEach(t => t.rows.forEach(r => {
      Object.keys(r.facets).forEach(h => {
        if (!seen[h]) seen[h] = [];
        if (r.facets[h] && seen[h].indexOf(r.facets[h]) === -1) seen[h].push(r.facets[h]);
      });
    }));
    const list = facetNames.filter(h => seen[h] && seen[h].length > 0).map(h => ({
      name: h,
      label: cap(h),
      values: seen[h].sort(cmpValues(h))
    }));
    setFacetList(list);
    const first = tables[0] ? tables[0].heads[0] : '';
    setFirstHead(first);
    if (!sortRef.current && first) {
      setSortBy(first);
      sortTables(first);
    }
    const init = {};
    list.forEach(f => {
      init[f.name] = selRef.current[f.name] || 'All';
    });
    setSel(init);
  };
  const onChange = value => {
    setQ(value);
    apply(value);
  };
  const clearAll = () => {
    const next = {};
    Object.keys(selRef.current).forEach(k => {
      next[k] = 'All';
    });
    setSel(next);
    setQ('');
    apply('');
    if (searchRef.current) searchRef.current.focus();
  };
  useEffect(() => {
    const tables = scan();
    deriveFacets(tables);
    const total = apply('');
    let retryTimer;
    if (total === 0) {
      retryTimer = setTimeout(() => {
        tablesRef.current = null;
        if (apply(qRef.current) > 0) deriveFacets(tablesRef.current); else setDisabled(true);
      }, 500);
    }
    const onKey = e => {
      if (e.key === 'Escape' && menuOpenRef.current !== null) closeMenu(menuOpenRef.current);
      if (!searchRef.current) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const active = document.activeElement;
      const tag = active && active.tagName;
      const editable = active && active.isContentEditable;
      const interactive = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A' || editable || active && active.getAttribute && active.getAttribute('role');
      if (e.key === '/' && !interactive) {
        const r = rootRef.current ? rootRef.current.getBoundingClientRect() : null;
        if (r && r.bottom > 0 && r.top < (window.innerHeight || 0)) {
          e.preventDefault();
          setMenu(null);
          searchRef.current.focus();
        }
      }
      if (e.key === 'Escape' && menuOpenRef.current === null && active === searchRef.current) {
        onChange('');
        searchRef.current.blur();
      }
    };
    const onDocClick = e => {
      const open = menuOpenRef.current;
      if (open !== null && menuRef.current[open] && !menuRef.current[open].contains(e.target)) setMenu(null);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDocClick);
    return () => {
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDocClick);
      (tablesRef.current || []).forEach(t => {
        t.box.style.display = '';
        t.rows.forEach(row => {
          row.el.style.display = '';
        });
      });
    };
  }, []);
  useEffect(() => {
    if (menuOpen !== null) focusSelected(menuOpen);
  }, [menuOpen]);
  if (disabled) return null;
  const facetActive = Object.keys(sel).some(h => sel[h] && sel[h] !== 'All');
  const sortOptions = [firstHead].concat(facetList.map(f => f.name)).filter((h, i, a) => h && a.indexOf(h) === i);
  return <>
      <style>{`
        .sf-root {
          --sf-accent: #D97757;
          --sf-bg: #fff;
          --sf-border: #E8E6DC;
          --sf-text: #141413;
          --sf-text-3: #73726C;
          --sf-text-4: #9C9A92;
        }
        .dark .sf-root {
          --sf-bg: #1a1918;
          --sf-border: #3a3936;
          --sf-text: #e8e6dc;
          --sf-text-3: #9c9a92;
          --sf-text-4: #73726c;
        }
        .sf-root .sf-end {
          position: absolute;
          right: 10px;
          top: 50%;
          transform: translateY(-50%);
        }
        .sf-root .sf-x {
          background: none;
          border: none;
          cursor: pointer;
          color: var(--sf-text-3);
          font-size: 14px;
          padding: 2px 4px;
          line-height: 1;
        }
      `}</style>
      <div ref={rootRef} className="sf-root" style={{
    margin: '16px 0 8px'
  }}>
        <div style={{
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap',
    alignItems: 'center'
  }}>
        <div style={{
    position: 'relative',
    flex: '1 1 260px',
    maxWidth: '480px'
  }}>
          <input ref={searchRef} value={q} onChange={e => onChange(e.target.value)} placeholder={placeholderText} aria-label={placeholderText} style={{
    width: '100%',
    padding: '8px 56px 8px 12px',
    borderRadius: '8px',
    border: '1px solid var(--sf-border)',
    background: 'var(--sf-bg)',
    color: 'var(--sf-text)',
    fontSize: '14px',
    outline: 'none',
    boxSizing: 'border-box'
  }} />
          {q ? <button type="button" onClick={() => {
    onChange('');
    if (searchRef.current) searchRef.current.focus();
  }} aria-label="Clear text" className="sf-end sf-x">
              ×
            </button> : <span className="sf-end" style={{
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '11px',
    color: 'var(--sf-text-4)',
    border: '1px solid var(--sf-border)',
    borderRadius: '3px',
    padding: '0 5px',
    pointerEvents: 'none'
  }}>
              /
            </span>}
        </div>
        {facetList.map(f => {
    const cur = sel[f.name] || 'All';
    const isOpen = menuOpen === f.name;
    return <div key={f.name} ref={el => {
      menuRef.current[f.name] = el;
    }} style={{
      position: 'relative'
    }}>
            <button type="button" onClick={() => setMenu(isOpen ? null : f.name)} onKeyDown={e => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!isOpen) setMenu(f.name); else focusSelected(f.name);
      }
    }} aria-haspopup="listbox" aria-expanded={isOpen} style={{
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: cur !== 'All' ? '8px 30px 8px 12px' : '8px 12px',
      borderRadius: '8px',
      border: '1px solid ' + (cur !== 'All' ? 'var(--sf-accent)' : 'var(--sf-border)'),
      background: 'var(--sf-bg)',
      color: cur === 'All' ? 'var(--sf-text-3)' : 'var(--sf-text)',
      fontSize: '13.5px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      maxWidth: '260px'
    }}>
              <span style={{
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }}>
                {f.label + ': ' + optionLabel(f, cur)}
              </span>
              <span aria-hidden="true" style={{
      fontSize: '9px',
      color: 'var(--sf-text-4)',
      transform: isOpen ? 'rotate(180deg)' : 'none',
      transition: 'transform 120ms'
    }}>
                ▼
              </span>
            </button>
            {cur !== 'All' && <button type="button" onClick={() => setFacet(f.name, 'All')} aria-label={'Clear ' + f.label + ' filter'} title={'Clear ' + f.label + ' filter'} className="sf-end sf-x">
                ×
              </button>}
            {isOpen && <div role="listbox" aria-label={f.label} onKeyDown={e => {
      const items = [...e.currentTarget.querySelectorAll('button')];
      const idx = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        (items[idx + 1] || items[0]).focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        (items[idx - 1] || items[items.length - 1]).focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        if (items[0]) items[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        if (items[items.length - 1]) items[items.length - 1].focus();
      } else if (e.key === 'Tab') {
        closeMenu(f.name);
      }
    }} style={{
      position: 'absolute',
      top: 'calc(100% + 6px)',
      left: 0,
      zIndex: 1000,
      minWidth: '260px',
      maxHeight: '340px',
      overflowY: 'auto',
      background: 'var(--sf-bg)',
      border: '1px solid var(--sf-border)',
      borderRadius: '10px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
      padding: '5px'
    }}>
                {['All'].concat(f.values).map(c => {
      const selected = cur === c;
      return <button key={c} role="option" aria-selected={selected} tabIndex={-1} onClick={() => setFacet(f.name, c)} style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        textAlign: 'left',
        padding: '7px 10px',
        borderRadius: '6px',
        border: 'none',
        background: 'transparent',
        color: selected ? 'var(--sf-accent)' : 'var(--sf-text)',
        fontWeight: selected ? 600 : 400,
        fontSize: '13.5px',
        cursor: 'pointer'
      }}>
                      <span aria-hidden="true" style={{
        width: '14px',
        color: 'var(--sf-accent)',
        flexShrink: 0
      }}>
                        {selected ? '✓' : ''}
                      </span>
                      {optionLabel(f, c)}
                    </button>;
    })}
              </div>}
          </div>;
  })}
        {sortOptions.length > 1 && <div role="group" aria-label="Sort by" style={{
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '13px',
    color: 'var(--sf-text-3)',
    whiteSpace: 'nowrap'
  }}>
            <span style={{
    marginRight: '4px'
  }}>Sort by</span>
            {sortOptions.map(o => {
    const on = sortBy === o;
    return <button key={o} type="button" aria-pressed={on} onClick={() => {
      setSortBy(o);
      sortTables(o);
    }} style={{
      padding: '6px 10px',
      borderRadius: '8px',
      border: '1px solid ' + (on ? 'var(--sf-accent)' : 'var(--sf-border)'),
      background: 'var(--sf-bg)',
      color: on ? 'var(--sf-text)' : 'var(--sf-text-3)',
      fontSize: '13px',
      cursor: 'pointer'
    }}>
                  {o.charAt(0).toUpperCase() + o.slice(1)}
                </button>;
  })}
          </div>}
        </div>
        <div aria-live="polite" style={{
    margin: '8px 0 0',
    fontSize: '13px',
    color: 'var(--sf-text-3)',
    minHeight: '1px'
  }}>
          {q.trim() === '' && !facetActive ? <>{counts.total} {nounText}</> : counts.shown === 0 ? <>
                {q.trim() === '' ? 'No ' + nounText + ' match the selected filters.' : facetActive ? 'No ' + nounText + ' match \u201c' + q + '\u201d with the selected filters.' : 'No ' + nounText + ' match \u201c' + q + '\u201d.'}{' '}
                <button type="button" onClick={clearAll} style={{
    background: 'none',
    border: 'none',
    padding: 0,
    color: 'var(--sf-accent)',
    cursor: 'pointer',
    font: 'inherit',
    textDecoration: 'underline'
  }}>
                  Clear filters
                </button>
                {children ? <> {children}</> : null}
              </> : <>
                Showing {counts.shown} of {counts.total} {nounText}
              </>}
        </div>
      </div>
    </>;
};

<BackToIndex href="#all-settings" label="Back to index" />

This reference page lists each key Claude Code reads from a settings file, plus the [short group of keys](#global-config-settings) it keeps in `~/.claude.json` instead. To pick a file, or check precedence, start with [Claude Code settings](/docs/en/settings).

<span id="available-settings" />

<span id="scopes" />

## All settings

Every key below links to its entry. Scope lists the [files](/docs/en/settings#settings-files-and-who-they-affect) it can go in: `User` is `~/.claude/settings.json`, `Project` is `.claude/settings.json`, `Local` is `.claude/settings.local.json`, and `Managed` is [what your organization deploys](/docs/en/managed-settings). `Any file` means all four, and `Global config` means [`~/.claude.json`](#global-config-settings).

<ReferenceFilter
  noun="settings"
  placeholder="Filter settings by key or purpose"
  facetOrder={{ scope: ["Any file", "User, local, or managed", "User or managed", "Managed", "Global config"] }}
  columnHelp={{
topic: "The section of this page that holds the entry. Use Sort by to group the table by topic.",
scope: "Which settings files can set the key: user (~/.claude/settings.json), project (.claude/settings.json), local (.claude/settings.local.json), or managed (deployed by your organization). Global config keys are in ~/.claude.json instead.",
}}
/>

| Key                                                                                             | Description                                                                                                                                                                                                                 | Topic                              | Scope                   |
| :---------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------- | :---------------------- |
| [`advisorModel`](#advisormodel)                                                                 | Pick which model answers when Claude asks the [advisor tool](/docs/en/advisor)                                                                                                                                                   | Model and responses                | Any file                |
| [`agent`](#agent)                                                                               | Start every session as a named [subagent](/docs/en/sub-agents) with its prompt, tools, and model                                                                                                                                 | Agents, sessions, and worktrees    | Any file                |
| [`agentPushNotifEnabled`](#agentpushnotifenabled)                                               | Let Claude send a [push notification to your phone](/docs/en/remote-control#mobile-push-notifications) when it decides to                                                                                                        | Remote, desktop, and notifications | Any file                |
| [`allowAllClaudeAiMcps`](#allowallclaudeaimcps)                                                 | Load the [claude.ai connectors](/docs/en/mcp) Claude Code fetches itself alongside a deployed [`managed-mcp.json`](/docs/en/managed-mcp#exclusive-control-with-managed-mcp-json)                                                      | MCP                                | Managed                 |
| [`allowedChannelPlugins`](#allowedchannelplugins)                                               | Replace the default allowlist of [channel plugins](/docs/en/channels#restrict-which-channel-plugins-can-run) that can push messages                                                                                              | Plugins and skills                 | Managed                 |
| [`allowedHttpHookUrls`](#allowedhttphookurls)                                                   | Limit which URLs [HTTP hooks](/docs/en/hooks) can target                                                                                                                                                                         | Hooks and automation               | Any file                |
| [`allowedMcpServers`](#allowedmcpservers)                                                       | Allowlist which [MCP servers](/docs/en/mcp) people can use                                                                                                                                                                       | MCP                                | Any file                |
| [`allowManagedHooksOnly`](#allowmanagedhooksonly)                                               | Run only the [hooks](/docs/en/hooks) your organization deploys                                                                                                                                                                   | Hooks and automation               | Managed                 |
| [`allowManagedMcpServersOnly`](#allowmanagedmcpserversonly)                                     | Make the managed [MCP](/docs/en/mcp) allowlist the only one that applies                                                                                                                                                         | MCP                                | Managed                 |
| [`allowManagedPermissionRulesOnly`](#allowmanagedpermissionrulesonly)                           | Make [managed settings](/docs/en/managed-settings) the only source of [permission rules](/docs/en/permissions#managed-settings)                                                                                                       | Permission settings                | Managed                 |
| [`alwaysThinkingEnabled`](#alwaysthinkingenabled)                                               | Turn [extended thinking](/docs/en/model-config#extended-thinking) off for every session                                                                                                                                          | Model and responses                | Any file                |
| [`apiKeyHelper`](#apikeyhelper)                                                                 | Generate the [API credential](/docs/en/authentication#credential-management) with your own command                                                                                                                               | Authentication and providers       | Any file                |
| [`askUserQuestionTimeout`](#askuserquestiontimeout)                                             | Let an unanswered question [auto-continue](/docs/en/tools-reference#question-auto-continue-timeout) after idle time                                                                                                              | Interface and terminal             | User or managed         |
| [`attribution`](#attribution)                                                                   | Customize the attribution Claude Code adds to commits and pull requests                                                                                                                                                     | Git and attribution                | Any file                |
| [`attribution.commit`](#attribution-commit)                                                     | Change or hide the trailer Claude Code adds to commits                                                                                                                                                                      | Git and attribution                | Any file                |
| [`attribution.pr`](#attribution-pr)                                                             | Change or hide the attribution line in pull request descriptions                                                                                                                                                            | Git and attribution                | Any file                |
| [`attribution.sessionUrl`](#attribution-sessionurl)                                             | Omit the claude.ai session link from [cloud](/docs/en/claude-code-on-the-web) and [Remote Control](/docs/en/remote-control) commits                                                                                                   | Git and attribution                | Any file                |
| [`autoCompactEnabled`](#autocompactenabled)                                                     | Turn [automatic compaction](/docs/en/context-window) off or on                                                                                                                                                                   | Memory and context                 | Any file                |
| [`autoCompactWindow`](#autocompactwindow)                                                       | Set how full the context gets before Claude Code [compacts](/docs/en/context-window)                                                                                                                                             | Memory and context                 | Any file                |
| [`autoConnectIde`](#autoconnectide)                                                             | Connect to a running [VS Code](/docs/en/vs-code) or [JetBrains](/docs/en/jetbrains#from-external-terminals) IDE automatically from an external terminal                                                                               | Global config settings             | Global config           |
| [`autoContinueAtUsageLimit`](#autocontinueatusagelimit)                                         | Wait in the open session and [continue the task automatically](/docs/en/interactive-mode#wait-for-a-usage-limit-to-reset) after a claude.ai usage limit resets                                                                   | Interface and terminal             | User or managed         |
| [`autoInstallIdeExtension`](#autoinstallideextension)                                           | Turn off automatic install of the [IDE extension](/docs/en/vs-code#install-the-extension) from a VS Code terminal                                                                                                                | Global config settings             | Global config           |
| [`autoMemoryDirectory`](#automemorydirectory)                                                   | Store [auto memory](/docs/en/memory#auto-memory) in a directory you choose                                                                                                                                                       | Memory and context                 | Any file                |
| [`autoMemoryEnabled`](#automemoryenabled)                                                       | Turn [auto memory](/docs/en/memory#auto-memory) off or on                                                                                                                                                                        | Memory and context                 | Any file                |
| [`autoMode`](#automode)                                                                         | Add your own allow and deny rules to the [auto mode](/docs/en/permission-modes#eliminate-prompts-with-auto-mode) classifier                                                                                                      | Permission settings                | User or managed         |
| [`autoMode.classifyAllShell`](#automode-classifyallshell)                                       | Send every shell command through the [auto mode classifier](/docs/en/permission-modes#what-the-classifier-blocks-by-default), even ones a narrow allow rule matches                                                              | Permission settings                | User or managed         |
| [`autoScrollEnabled`](#autoscrollenabled)                                                       | [Follow new output](/docs/en/fullscreen#auto-follow) to the bottom in fullscreen rendering                                                                                                                                       | Interface and terminal             | Any file                |
| [`autoUpdatesChannel`](#autoupdateschannel)                                                     | Follow the stable [release channel](/docs/en/setup#configure-release-channel) instead of latest                                                                                                                                  | Updates and versioning             | Any file                |
| [`availableModels`](#availablemodels)                                                           | [Restrict which models](/docs/en/model-config#restrict-model-selection) people can pick                                                                                                                                          | Model and responses                | Any file                |
| [`awaySummaryEnabled`](#awaysummaryenabled)                                                     | Turn off the [session recap](/docs/en/interactive-mode#session-recap) shown when you come back to the terminal                                                                                                                   | Remote, desktop, and notifications | Any file                |
| [`awsAuthRefresh`](#awsauthrefresh)                                                             | Refresh expired [Bedrock credentials](/docs/en/amazon-bedrock#advanced-credential-configuration) in `.aws` with your own command                                                                                                 | Authentication and providers       | Any file                |
| [`awsCredentialExport`](#awscredentialexport)                                                   | Supply [Bedrock credentials](/docs/en/amazon-bedrock#advanced-credential-configuration) as JSON from your own command                                                                                                            | Authentication and providers       | Any file                |
| [`axScreenReader`](#axscreenreader)                                                             | Render [screen-reader friendly output](/docs/en/accessibility)                                                                                                                                                                   | Interface and terminal             | Any file                |
| [`blockedMarketplaces`](#blockedmarketplaces)                                                   | Block [plugin marketplace](/docs/en/plugin-marketplaces) sources for your organization                                                                                                                                           | Plugins and skills                 | Managed                 |
| [`browserExternalPageTools`](#browserexternalpagetools)                                         | Keep Claude's tools off external pages in the [desktop](/docs/en/desktop) Browser pane                                                                                                                                           | Tools                              | Managed                 |
| [`channelsEnabled`](#channelsenabled)                                                           | Allow [channels](/docs/en/channels#enable-channels-for-your-organization) for your organization                                                                                                                                  | Plugins and skills                 | Managed                 |
| [`claudeMd`](#claudemd)                                                                         | Inject organization-wide [CLAUDE.md](/docs/en/memory#deploy-organization-wide-claude-md) instructions from managed settings                                                                                                      | Memory and context                 | Managed                 |
| [`claudeMdExcludes`](#claudemdexcludes)                                                         | Skip specific [CLAUDE.md](/docs/en/memory#exclude-specific-claude-md-files) files when memory loads                                                                                                                              | Memory and context                 | Any file                |
| [`cleanupPeriodDays`](#cleanupperioddays)                                                       | Choose how many days Claude Code keeps [transcripts](/docs/en/data-usage#data-retention) before deleting them                                                                                                                    | Privacy and telemetry              | Any file                |
| [`companyAnnouncements`](#companyannouncements)                                                 | Show your organization's announcements at startup                                                                                                                                                                           | Interface and terminal             | Any file                |
| [`crossSessionInbound`](#crosssessioninbound)                                                   | Choose whether Claude Code delivers [messages from your other sessions](/docs/en/cross-session-messaging#control-inbound-messages), shows a notice without delivering them, or refuses them                                      | Agents, sessions, and worktrees    | Any file                |
| [`defaultShell`](#defaultshell)                                                                 | Choose whether Bash or PowerShell runs the shell commands you type with the [`!` prefix](/docs/en/interactive-mode#shell-mode-with-prefix)                                                                                       | Interface and terminal             | Any file                |
| [`deniedMcpServers`](#deniedmcpservers)                                                         | Block specific [MCP servers](/docs/en/mcp) by URL, command, or name                                                                                                                                                              | MCP                                | Any file                |
| [`dialogExpiry`](#dialogexpiry)                                                                 | Set how long Claude Code waits for [Remote Control](/docs/en/remote-control) or an SDK host to answer a forwarded dialog before it cancels the dialog                                                                            | Interface and terminal             | User or managed         |
| [`diffTool`](#difftool)                                                                         | Choose whether Claude's proposed file changes open in the [VS Code](/docs/en/vs-code) or [JetBrains](/docs/en/jetbrains#features) diff viewer or stay in the terminal                                                                 | Global config settings             | Global config           |
| [`disableAgentView`](#disableagentview)                                                         | Turn off background agents and [agent view](/docs/en/agent-view)                                                                                                                                                                 | Agents, sessions, and worktrees    | Any file                |
| [`disableAllHooks`](#disableallhooks)                                                           | Turn off [hooks](/docs/en/hooks), a custom [status line](/docs/en/statusline), and a custom [`@` file suggestion](/docs/en/interactive-mode#quick-commands) command at once                                                                | Hooks and automation               | Any file                |
| [`disableArtifact`](#disableartifact)                                                           | Deprecated; use `enableArtifact` to turn the [Artifact tool](/docs/en/artifacts) off                                                                                                                                             | Remote, desktop, and notifications | Any file                |
| [`disableAutoMode`](#disableautomode)                                                           | Remove [auto mode](/docs/en/permission-modes#eliminate-prompts-with-auto-mode) from the permission mode cycle                                                                                                                    | Permission settings                | Any file                |
| [`disableBrowserExternalNavigation`](#disablebrowserexternalnavigation)                         | Limit the [desktop](/docs/en/desktop) Browser pane to localhost for people and Claude                                                                                                                                            | Tools                              | Managed                 |
| [`disableBundledSkills`](#disablebundledskills)                                                 | Turn off the [skills](/docs/en/skills#bundled-skills) and [workflows](/docs/en/workflows) included with Claude Code                                                                                                                   | Plugins and skills                 | Any file                |
| [`disableClaudeAiConnectors`](#disableclaudeaiconnectors)                                       | Turn off [claude.ai connectors](/docs/en/mcp#disable-claude-ai-connectors) so Claude Code doesn't fetch them                                                                                                                     | MCP                                | Any file                |
| [`disableCommandPluginSources`](#disablecommandpluginsources)                                   | Block [plugins](/docs/en/plugins) that install by running a marketplace-declared command                                                                                                                                         | Plugins and skills                 | Managed                 |
| [`disableDeepLinkRegistration`](#disabledeeplinkregistration)                                   | Stop Claude Code from registering the [`claude-cli://` handler](/docs/en/deep-links)                                                                                                                                             | Remote, desktop, and notifications | Any file                |
| [`disableDesktopLocalSessions`](#disabledesktoplocalsessions)                                   | Turn off [Desktop Code sessions](/docs/en/desktop#local-sessions-on-managed-devices) that run on the device, leaving SSH to other hosts and cloud                                                                                | Remote, desktop, and notifications | Managed                 |
| [`disabledMcpjsonServers`](#disabledmcpjsonservers)                                             | Reject specific servers from a project's [`.mcp.json`](/docs/en/mcp#project-scope)                                                                                                                                               | MCP                                | Any file                |
| [`disableMobileSimulatorTools`](#disablemobilesimulatortools)                                   | Block Claude's tools in the [desktop](/docs/en/desktop) iOS Simulator pane                                                                                                                                                       | Tools                              | Managed                 |
| [`disableRemoteControl`](#disableremotecontrol)                                                 | Turn off [Remote Control](/docs/en/remote-control) everywhere it can start                                                                                                                                                       | Remote, desktop, and notifications | Any file                |
| [`disableSideloadFlags`](#disablesideloadflags)                                                 | Reject the CLI flags that sideload [plugins](/docs/en/plugins), [subagents](/docs/en/sub-agents), and [MCP servers](/docs/en/mcp)                                                                                                          | Enterprise and managed settings    | Managed                 |
| [`disableSkillShellExecution`](#disableskillshellexecution)                                     | Stop [skills](/docs/en/skills) and custom commands from running inline shell                                                                                                                                                     | Plugins and skills                 | Any file                |
| [`disableWorkflows`](#disableworkflows)                                                         | Turn [dynamic workflows](/docs/en/workflows) off for everyone; use `enableWorkflows` for yourself                                                                                                                                | Hooks and automation               | Any file                |
| [`editorMode`](#editormode)                                                                     | Use [vim key bindings](/docs/en/interactive-mode#vim-editor-mode) in the input prompt                                                                                                                                            | Interface and terminal             | Any file                |
| [`effortLevel`](#effortlevel)                                                                   | Save the [`/effort` level](/docs/en/model-config#adjust-effort-level) so future sessions reason more or less deeply                                                                                                              | Model and responses                | Any file                |
| [`emojiCompletionEnabled`](#emojicompletionenabled)                                             | Turn off [`:shortcode:` emoji suggestions and replacement](/docs/en/interactive-mode#emoji-shortcodes) in the prompt input                                                                                                       | Interface and terminal             | Any file                |
| [`enableAllProjectMcpServers`](#enableallprojectmcpservers)                                     | Approve every server in project [`.mcp.json`](/docs/en/mcp#project-server-approvals-and-workspace-trust) files without a prompt                                                                                                  | MCP                                | Any file                |
| [`enableArtifact`](#enableartifact)                                                             | Turn the [Artifact tool](/docs/en/artifacts) off with a `false` in any file; no file can turn it back on                                                                                                                         | Remote, desktop, and notifications | Any file                |
| [`enabledMcpjsonServers`](#enabledmcpjsonservers)                                               | Approve specific servers from a project's [`.mcp.json`](/docs/en/mcp#project-server-approvals-and-workspace-trust)                                                                                                               | MCP                                | Any file                |
| [`enabledPlugins`](#enabledplugins)                                                             | Turn individual [plugins](/docs/en/plugins) on or off per scope                                                                                                                                                                  | Plugins and skills                 | Any file                |
| [`enableWorkflows`](#enableworkflows)                                                           | Turn [dynamic workflows](/docs/en/workflows) on or off against your plan's default                                                                                                                                               | Hooks and automation               | Any file                |
| [`enforceAvailableModels`](#enforceavailablemodels)                                             | Keep the [`/model` Default choice](/docs/en/model-config#enforce-the-allowlist-for-the-default-model) inside your `availableModels` allowlist                                                                                    | Model and responses                | Any file                |
| [`env`](#env)                                                                                   | Set [environment variables](/docs/en/env-vars#in-settings-files) for every session and its subprocesses                                                                                                                          | Memory and context                 | Any file                |
| [`externalEditorContext`](#externaleditorcontext)                                               | Show Claude's last response as comments when you press [Ctrl+G](/docs/en/interactive-mode#general-controls) to edit                                                                                                              | Global config settings             | Global config           |
| [`extraKnownMarketplaces`](#extraknownmarketplaces)                                             | Register [marketplaces](/docs/en/plugin-marketplaces) for a repository or an organization                                                                                                                                        | Plugins and skills                 | Any file                |
| [`fallbackModel`](#fallbackmodel)                                                               | Name [backup models](/docs/en/model-config#fallback-model-chains) for when the primary is overloaded                                                                                                                             | Model and responses                | Any file                |
| [`fastMode`](#fastmode)                                                                         | Turn [fast mode](/docs/en/fast-mode) on for sessions where it's available                                                                                                                                                        | Model and responses                | Any file                |
| [`fastModePerSessionOptIn`](#fastmodepersessionoptin)                                           | Require people to turn [fast mode](/docs/en/fast-mode) on each session                                                                                                                                                           | Model and responses                | Any file                |
| [`feedbackDrafts`](#feedbackdrafts)                                                             | Control whether Claude queues [feedback drafts](/docs/en/tools-reference#sendfeedback-tool-behavior) for you to review                                                                                                           | Privacy and telemetry              | User or managed         |
| [`feedbackSurveyRate`](#feedbacksurveyrate)                                                     | Change how often the [session quality survey](/docs/en/data-usage#session-quality-surveys) appears                                                                                                                               | Privacy and telemetry              | Any file                |
| [`fileCheckpointingEnabled`](#filecheckpointingenabled)                                         | Turn off or on the file snapshots that [`/rewind`](/docs/en/checkpointing) restores                                                                                                                                              | Memory and context                 | Any file                |
| [`fileSuggestion`](#filesuggestion)                                                             | Supply [`@` file autocomplete](/docs/en/interactive-mode#quick-commands) from your own command                                                                                                                                   | Interface and terminal             | Any file                |
| [`footerLinksRegexes`](#footerlinksregexes)                                                     | Make issue or review IDs in output into [clickable links](/docs/en/statusline#clickable-links) below the input box                                                                                                               | Interface and terminal             | User or managed         |
| [`forceLoginGatewayUrl`](#forcelogingatewayurl)                                                 | Set the [gateway URL](/docs/en/claude-apps-gateway#set-the-gateway-url) the login screen connects to                                                                                                                             | Authentication and providers       | Managed                 |
| [`forceLoginMethod`](#forceloginmethod)                                                         | [Restrict login](/docs/en/authentication#restrict-login-to-your-organization) to claude.ai, Claude Console, or a [cloud gateway](/docs/en/claude-apps-gateway)                                                                        | Authentication and providers       | Any file                |
| [`forceLoginOrgUUID`](#forceloginorguuid)                                                       | [Pin claude.ai logins to your organization](/docs/en/authentication#restrict-login-to-your-organization); only a managed source enforces it                                                                                      | Authentication and providers       | Any file                |
| [`forceRemoteSettingsRefresh`](#forceremotesettingsrefresh)                                     | Block startup until [server-managed settings](/docs/en/server-managed-settings) are freshly fetched                                                                                                                              | Enterprise and managed settings    | Managed                 |
| [`gcpAuthRefresh`](#gcpauthrefresh)                                                             | Refresh [Google Cloud credentials](/docs/en/google-vertex-ai#advanced-credential-configuration) with your own command                                                                                                            | Authentication and providers       | Any file                |
| [`hooks`](#hooks)                                                                               | Run your own commands as [hooks](/docs/en/hooks) at points in Claude Code's lifecycle                                                                                                                                            | Hooks and automation               | Any file                |
| [`httpHookAllowedEnvVars`](#httphookallowedenvvars)                                             | Limit which env vars [HTTP hooks](/docs/en/hooks) can put in headers                                                                                                                                                             | Hooks and automation               | Any file                |
| [`includeCoAuthoredBy`](#includecoauthoredby)                                                   | Deprecated; use `attribution` to hide or change commit and PR attribution                                                                                                                                                   | Git and attribution                | Any file                |
| [`includeGitInstructions`](#includegitinstructions)                                             | Remove the built-in commit and PR instructions from the [system prompt](/docs/en/sub-agents#what-loads-at-startup)                                                                                                               | Git and attribution                | Any file                |
| [`inputNeededNotifEnabled`](#inputneedednotifenabled)                                           | Get a [push notification](/docs/en/remote-control#mobile-push-notifications) when Claude is waiting on you                                                                                                                       | Remote, desktop, and notifications | Any file                |
| [`isolatePeerMachines`](#isolatepeermachines)                                                   | Ask you before Claude [messages one of your sessions on another machine](/docs/en/cross-session-messaging#require-approval-for-cross-machine-messages)                                                                           | Agents, sessions, and worktrees    | Any file                |
| [`keybindingFlavor`](#keybindingflavor)                                                         | Make `Ctrl+W` [delete back to the previous whitespace](/docs/en/interactive-mode#make-ctrl-w-delete-back-to-whitespace), as Bash does                                                                                            | Interface and terminal             | Any file                |
| [`language`](#language)                                                                         | Have Claude respond in a language other than English                                                                                                                                                                        | Model and responses                | Any file                |
| [`managedSourcesBehavior`](#managedsourcesbehavior)                                             | Compose every [managed source](/docs/en/managed-settings#how-claude-code-combines-managed-sources) you deploy instead of using the highest-priority one alone                                                                    | Enterprise and managed settings    | Managed                 |
| [`minimumVersion`](#minimumversion)                                                             | Keep [auto-updates](/docs/en/setup#pin-a-minimum-version) from installing anything below a version                                                                                                                               | Updates and versioning             | Any file                |
| [`model`](#model)                                                                               | Change the [model](/docs/en/model-config#set-a-default-model-for-new-sessions) Claude Code starts with                                                                                                                           | Model and responses                | Any file                |
| [`modelOverrides`](#modeloverrides)                                                             | [Map model IDs](/docs/en/model-config#override-model-ids-per-version) to your provider's IDs, such as Bedrock ARNs                                                                                                               | Model and responses                | Any file                |
| [`modelPicker`](#modelpicker)                                                                   | Choose which models the [`/model` picker](/docs/en/model-config#available-models) lists, in your own order and with your own labels                                                                                              | Model and responses                | User or managed         |
| [`modelPricing`](#modelpricing)                                                                 | Report spend at your organization's contracted rates instead of list price                                                                                                                                                  | Model and responses                | Managed                 |
| [`otelHeadersHelper`](#otelheadershelper)                                                       | Generate rotating [OpenTelemetry](/docs/en/monitoring-usage#dynamic-headers) headers with your own command                                                                                                                       | Authentication and providers       | Any file                |
| [`outputStyle`](#outputstyle)                                                                   | Change Claude's role, tone, and output format with an [output style](/docs/en/output-styles)                                                                                                                                     | Model and responses                | Any file                |
| [`parentSettingsBehavior`](#parentsettingsbehavior)                                             | Apply or drop restrictions an [SDK or IDE host](/docs/en/managed-settings#let-an-embedding-host-add-policy) passes when you deploy [managed settings](/docs/en/managed-settings)                                                      | Enterprise and managed settings    | Managed                 |
| [`permissionExplainerEnabled`](#permissionexplainerenabled)                                     | Turn off the Ctrl+E command explanation on shell [permission prompts](/docs/en/permissions#permission-system)                                                                                                                    | Global config settings             | Global config           |
| [`permissions`](#permissions)                                                                   | Set allow, ask, and deny rules and the starting [permission mode](/docs/en/permission-modes)                                                                                                                                     | Permission settings                | Any file                |
| [`permissions.additionalDirectories`](#permissions-additionaldirectories)                       | Give Claude file access to [directories outside the current one](/docs/en/permissions#working-directories)                                                                                                                       | Permission settings                | Any file                |
| [`permissions.allow`](#permissions-allow)                                                       | Approve listed [tool uses](/docs/en/permissions#permission-rule-syntax) without a prompt                                                                                                                                         | Permission settings                | Any file                |
| [`permissions.ask`](#permissions-ask)                                                           | Always prompt before listed [tool uses](/docs/en/permissions#permission-rule-syntax)                                                                                                                                             | Permission settings                | Any file                |
| [`permissions.defaultMode`](#permissions-defaultmode)                                           | Set the [permission mode](/docs/en/permission-modes#which-mode-a-session-starts-in) new sessions start in                                                                                                                        | Permission settings                | Any file                |
| [`permissions.deny`](#permissions-deny)                                                         | Block listed [tool uses](/docs/en/permissions#permission-rule-syntax), including reads of files that hold secrets                                                                                                                | Permission settings                | Any file                |
| [`permissions.disableBypassPermissionsMode`](#permissions-disablebypasspermissionsmode)         | Prevent anyone from entering [bypassPermissions mode](/docs/en/permission-modes#skip-all-checks-with-bypasspermissions-mode)                                                                                                     | Permission settings                | Any file                |
| [`plansDirectory`](#plansdirectory)                                                             | Choose where [plan mode](/docs/en/permission-modes#analyze-before-you-edit-with-plan-mode) writes plan files                                                                                                                     | Memory and context                 | Any file                |
| [`pluginConfigs`](#pluginconfigs)                                                               | Store the answers you gave a [plugin](/docs/en/plugins)'s configuration dialog                                                                                                                                                   | Plugins and skills                 | User or managed         |
| [`pluginSuggestionMarketplaces`](#pluginsuggestionmarketplaces)                                 | Choose which [marketplaces](/docs/en/plugin-marketplaces#managed-marketplace-restrictions) can surface plugin install suggestions in `/plugin`                                                                                   | Plugins and skills                 | Managed                 |
| [`pluginTrustMessage`](#plugintrustmessage)                                                     | Add your own text to the [plugin](/docs/en/plugins) trust warning                                                                                                                                                                | Plugins and skills                 | Managed                 |
| [`policyHelper`](#policyhelper)                                                                 | Run an executable that computes [managed settings](/docs/en/managed-settings#compute-the-policy-with-a-helper-program) at startup                                                                                                | Enterprise and managed settings    | Managed                 |
| [`policyHelper.path`](#policyhelper-path)                                                       | Name the [helper executable](/docs/en/managed-settings#compute-the-policy-with-a-helper-program) Claude Code runs                                                                                                                | Enterprise and managed settings    | Managed                 |
| [`policyHelper.refreshIntervalMs`](#policyhelper-refreshintervalms)                             | Re-run the [helper](/docs/en/managed-settings#compute-the-policy-with-a-helper-program) in the background on an interval                                                                                                         | Enterprise and managed settings    | Managed                 |
| [`policyHelper.timeoutMs`](#policyhelper-timeoutms)                                             | Set how long Claude Code waits for the [helper](/docs/en/managed-settings#compute-the-policy-with-a-helper-program)                                                                                                              | Enterprise and managed settings    | Managed                 |
| [`preferredNotifChannel`](#preferrednotifchannel)                                               | Choose a [terminal bell or desktop notification](/docs/en/terminal-config#get-a-terminal-bell-or-notification) for task completion                                                                                               | Remote, desktop, and notifications | Any file                |
| [`prefersReducedMotion`](#prefersreducedmotion)                                                 | [Reduce or turn off](/docs/en/accessibility#accessibility-settings) spinner, shimmer, and flash animations                                                                                                                       | Interface and terminal             | Any file                |
| [`processWrapper`](#processwrapper)                                                             | Run Claude Code's background processes through a [corporate launcher](/docs/en/corporate-launcher) on macOS and Linux                                                                                                            | Agents, sessions, and worktrees    | User or managed         |
| [`promptCacheTtl`](#promptcachettl)                                                             | Choose the [prompt cache lifetime](/docs/en/prompt-caching#cache-lifetime) for the main conversation                                                                                                                             | Model and responses                | Any file                |
| [`promptSuggestionEnabled`](#promptsuggestionenabled)                                           | Hide the grayed-out [prompt suggestions](/docs/en/interactive-mode#prompt-suggestions) in the input box                                                                                                                          | Interface and terminal             | Any file                |
| [`prUrlTemplate`](#prurltemplate)                                                               | Point PR links at an internal code-review tool instead of github.com                                                                                                                                                        | Git and attribution                | Any file                |
| [`remote.defaultEnvironmentId`](#remote-defaultenvironmentid)                                   | Pick the default [cloud environment](/docs/en/cloud-environments) for `claude --cloud`; a self-hosted `ccpool_` ID is read only from user and managed settings and `--settings`                                                  | Remote, desktop, and notifications | Any file                |
| [`remoteControlAtStartup`](#remotecontrolatstartup)                                             | Connect [Remote Control](/docs/en/remote-control#enable-remote-control-for-all-sessions) automatically when a session starts                                                                                                     | Remote, desktop, and notifications | Any file                |
| [`requiredMaximumVersion`](#requiredmaximumversion)                                             | [Refuse to start](/docs/en/setup#pin-a-minimum-version) on a version newer than your organization allows                                                                                                                         | Updates and versioning             | Managed                 |
| [`requiredMinimumVersion`](#requiredminimumversion)                                             | [Refuse to start](/docs/en/setup#pin-a-minimum-version) on a version older than your organization requires                                                                                                                       | Updates and versioning             | Managed                 |
| [`respectGitignore`](#respectgitignore)                                                         | Keep gitignored files out of the [`@` file picker](/docs/en/interactive-mode#quick-commands)                                                                                                                                     | Interface and terminal             | Any file                |
| [`respondToBashCommands`](#respondtobashcommands)                                               | Stop Claude from responding after a [`!` shell command](/docs/en/interactive-mode#shell-mode-with-prefix) runs                                                                                                                   | Interface and terminal             | Any file                |
| [`sandbox`](#sandbox)                                                                           | [Isolate Bash commands](/docs/en/sandboxing) from your filesystem and network on macOS, Linux, and WSL2                                                                                                                          | Sandbox settings                   | Any file                |
| [`sandbox.allowAppleEvents`](#sandbox-allowappleevents)                                         | Let [sandboxed](/docs/en/sandboxing) commands send Apple Events on macOS                                                                                                                                                         | Sandbox settings                   | User or managed         |
| [`sandbox.allowUnsandboxedCommands`](#sandbox-allowunsandboxedcommands)                         | Let Claude retry a blocked command outside the [sandbox](/docs/en/sandboxing#the-unsandboxed-retry-escape-hatch), or forbid it                                                                                                   | Sandbox settings                   | Any file                |
| [`sandbox.autoAllowBashIfSandboxed`](#sandbox-autoallowbashifsandboxed)                         | Run [sandboxed](/docs/en/sandboxing#auto-allow-mode) commands without a permission prompt                                                                                                                                        | Sandbox settings                   | Any file                |
| [`sandbox.bwrapPath`](#sandbox-bwrappath)                                                       | Point the [sandbox](/docs/en/sandboxing) at a bubblewrap binary outside `PATH`                                                                                                                                                   | Sandbox settings                   | Managed                 |
| [`sandbox.credentials`](#sandbox-credentials)                                                   | Hide or mask credential files and variables inside the [sandbox](/docs/en/sandboxing#protect-credentials)                                                                                                                        | Sandbox settings                   | Any file                |
| [`sandbox.credentials.allowPlaintextInject`](#sandbox-credentials-allowplaintextinject)         | Let [masked credentials](/docs/en/sandboxing#mask-credentials) reach plain HTTP services on trusted test networks                                                                                                                | Sandbox settings                   | User or managed         |
| [`sandbox.credentials.awsPairs`](#sandbox-credentials-awspairs)                                 | Link custom-named AWS key variables into one credential for [re-signing](/docs/en/sandboxing#re-sign-aws-requests)                                                                                                               | Sandbox settings                   | User or managed         |
| [`sandbox.credentials.envVars`](#sandbox-credentials-envvars)                                   | Unset or mask an environment variable inside the [sandbox](/docs/en/sandboxing#mask-environment-variables)                                                                                                                       | Sandbox settings                   | Any file                |
| [`sandbox.credentials.files`](#sandbox-credentials-files)                                       | Block or mask reads of a credential file inside the [sandbox](/docs/en/sandboxing#mask-credential-files)                                                                                                                         | Sandbox settings                   | Any file                |
| [`sandbox.credentials.sigv4`](#sandbox-credentials-sigv4)                                       | Choose whether streaming, presigned, or [SigV4A AWS requests](/docs/en/sandboxing#re-sign-aws-requests) fail or pass through                                                                                                     | Sandbox settings                   | User or managed         |
| [`sandbox.enabled`](#sandbox-enabled)                                                           | Turn on [Bash sandboxing](/docs/en/sandboxing#get-started) on macOS, Linux, and WSL2                                                                                                                                             | Sandbox settings                   | Any file                |
| [`sandbox.enableWeakerNestedSandbox`](#sandbox-enableweakernestedsandbox)                       | Run the Linux [sandbox](/docs/en/sandboxing) inside an unprivileged container                                                                                                                                                    | Sandbox settings                   | Any file                |
| [`sandbox.enableWeakerNetworkIsolation`](#sandbox-enableweakernetworkisolation)                 | Let `gh`, `gcloud`, and `terraform` verify TLS behind a MITM proxy inside the [sandbox](/docs/en/sandboxing#troubleshooting) on macOS                                                                                            | Sandbox settings                   | Any file                |
| [`sandbox.excludedCommands`](#sandbox-excludedcommands)                                         | Name commands that always run outside the [sandbox](/docs/en/sandboxing)                                                                                                                                                         | Sandbox settings                   | Any file                |
| [`sandbox.failIfUnavailable`](#sandbox-failifunavailable)                                       | Refuse to start when the [sandbox](/docs/en/sandboxing) can't, instead of running unsandboxed                                                                                                                                    | Sandbox settings                   | Any file                |
| [`sandbox.filesystem`](#sandbox-filesystem)                                                     | Control which paths [sandboxed](/docs/en/sandboxing#filesystem-isolation) commands can read and write                                                                                                                            | Sandbox settings                   | Any file                |
| [`sandbox.filesystem.allowManagedReadPathsOnly`](#sandbox-filesystem-allowmanagedreadpathsonly) | Stop developers from re-opening [read paths your organization blocked](/docs/en/sandboxing#keep-developers-from-widening-the-policy)                                                                                             | Sandbox settings                   | Managed                 |
| [`sandbox.filesystem.allowRead`](#sandbox-filesystem-allowread)                                 | Re-open reading inside a region [`denyRead`](#sandbox-filesystem-denyread) blocks                                                                                                                                           | Sandbox settings                   | Any file                |
| [`sandbox.filesystem.allowWrite`](#sandbox-filesystem-allowwrite)                               | Add paths [sandboxed](/docs/en/sandboxing) commands can write to                                                                                                                                                                 | Sandbox settings                   | Any file                |
| [`sandbox.filesystem.denyRead`](#sandbox-filesystem-denyread)                                   | Block [sandboxed](/docs/en/sandboxing) commands from reading specific paths                                                                                                                                                      | Sandbox settings                   | Any file                |
| [`sandbox.filesystem.denyWrite`](#sandbox-filesystem-denywrite)                                 | Block [sandboxed](/docs/en/sandboxing) commands from writing to specific paths                                                                                                                                                   | Sandbox settings                   | Any file                |
| [`sandbox.filesystem.disabled`](#sandbox-filesystem-disabled)                                   | [Turn off filesystem isolation](/docs/en/sandboxing#disable-filesystem-isolation) while keeping network isolation                                                                                                                | Sandbox settings                   | User or managed         |
| [`sandbox.ignoreViolations`](#sandbox-ignoreviolations)                                         | Silence violation reports for paths a command is expected to probe                                                                                                                                                          | Sandbox settings                   | Any file                |
| [`sandbox.network`](#sandbox-network)                                                           | Control which hosts, ports, and sockets [sandboxed](/docs/en/sandboxing#network-isolation) commands reach                                                                                                                        | Sandbox settings                   | Any file                |
| [`sandbox.network.allowAllUnixSockets`](#sandbox-network-allowallunixsockets)                   | Let [sandboxed](/docs/en/sandboxing) commands connect to every Unix socket                                                                                                                                                       | Sandbox settings                   | Any file                |
| [`sandbox.network.allowedDomains`](#sandbox-network-alloweddomains)                             | Pre-allow domains so [sandboxed](/docs/en/sandboxing) commands don't prompt for them                                                                                                                                             | Sandbox settings                   | Any file                |
| [`sandbox.network.allowLocalBinding`](#sandbox-network-allowlocalbinding)                       | Let [sandboxed](/docs/en/sandboxing) commands bind to localhost ports on macOS                                                                                                                                                   | Sandbox settings                   | Any file                |
| [`sandbox.network.allowMachLookup`](#sandbox-network-allowmachlookup)                           | Let macOS [sandboxed](/docs/en/sandboxing) tools like the iOS Simulator or Playwright reach their XPC services                                                                                                                   | Sandbox settings                   | Any file                |
| [`sandbox.network.allowManagedDomainsOnly`](#sandbox-network-allowmanageddomainsonly)           | Lock the network allowlist to [managed settings](/docs/en/sandboxing#keep-developers-from-widening-the-policy)                                                                                                                   | Sandbox settings                   | Managed                 |
| [`sandbox.network.allowUnixSockets`](#sandbox-network-allowunixsockets)                         | List Unix socket paths [sandboxed](/docs/en/sandboxing) commands can use on macOS                                                                                                                                                | Sandbox settings                   | Any file                |
| [`sandbox.network.deniedDomains`](#sandbox-network-denieddomains)                               | Block domains for [sandboxed](/docs/en/sandboxing) commands, even inside an allowed wildcard                                                                                                                                     | Sandbox settings                   | Any file                |
| [`sandbox.network.httpProxyPort`](#sandbox-network-httpproxyport)                               | Route [sandbox](/docs/en/sandboxing#custom-proxy-configuration) HTTP traffic through your own proxy                                                                                                                              | Sandbox settings                   | Any file                |
| [`sandbox.network.socksProxyPort`](#sandbox-network-socksproxyport)                             | Route [sandbox](/docs/en/sandboxing#custom-proxy-configuration) SOCKS traffic through your own proxy                                                                                                                             | Sandbox settings                   | Any file                |
| [`sandbox.network.strictAllowlist`](#sandbox-network-strictallowlist)                           | Deny hosts outside the [allowlist](/docs/en/sandboxing#network-isolation) instead of prompting                                                                                                                                   | Sandbox settings                   | User or managed         |
| [`sandbox.network.tlsTerminate`](#sandbox-network-tlsterminate)                                 | Have the [sandbox](/docs/en/sandboxing#network-isolation) proxy terminate TLS so it can read HTTPS requests                                                                                                                      | Sandbox settings                   | User or managed         |
| [`sandbox.ripgrep`](#sandbox-ripgrep)                                                           | Use your own ripgrep binary inside the [sandbox](/docs/en/sandboxing)                                                                                                                                                            | Sandbox settings                   | User or managed         |
| [`sandbox.socatPath`](#sandbox-socatpath)                                                       | Point the [sandbox](/docs/en/sandboxing) proxy at a `socat` binary outside `PATH`                                                                                                                                                | Sandbox settings                   | Managed                 |
| [`showClearContextOnPlanAccept`](#showclearcontextonplanaccept)                                 | Show a "clear context" option on the [plan accept screen](/docs/en/permission-modes#review-and-approve-a-plan)                                                                                                                   | Interface and terminal             | Any file                |
| [`showThinkingSummaries`](#showthinkingsummaries)                                               | See summaries of Claude's [thinking](/docs/en/model-config#extended-thinking) instead of a collapsed stub                                                                                                                        | Model and responses                | Any file                |
| [`showTurnDuration`](#showturnduration)                                                         | Hide the "Cooked for" duration after each response                                                                                                                                                                          | Interface and terminal             | Any file                |
| [`skillListingBudgetFraction`](#skilllistingbudgetfraction)                                     | Reserve more or less context for the [skill listing](/docs/en/skills#skill-descriptions-are-cut-short)                                                                                                                           | Memory and context                 | Any file                |
| [`skillListingMaxDescChars`](#skilllistingmaxdescchars)                                         | Cap each skill's description length in the [skill listing](/docs/en/skills#skill-descriptions-are-cut-short)                                                                                                                     | Memory and context                 | Any file                |
| [`skillOverrides`](#skilloverrides)                                                             | [Hide or collapse a skill](/docs/en/skills#override-skill-visibility-from-settings) without editing its SKILL.md                                                                                                                 | Plugins and skills                 | Any file                |
| [`skipAutoPermissionPrompt`](#skipautopermissionprompt)                                         | Skip the one-time notice Claude Code shows when you first enter [auto mode](/docs/en/permission-modes#eliminate-prompts-with-auto-mode) yourself rather than through the built-in default                                        | Permission settings                | User or managed         |
| [`skipDangerousModePermissionPrompt`](#skipdangerousmodepermissionprompt)                       | Skip the confirmation dialog before [bypassPermissions mode](/docs/en/permission-modes#skip-all-checks-with-bypasspermissions-mode)                                                                                              | Permission settings                | User, local, or managed |
| [`skipWebFetchPreflight`](#skipwebfetchpreflight)                                               | Skip the [WebFetch hostname check](/docs/en/tools-reference#webfetch-tool-behavior) when Anthropic is unreachable                                                                                                                | Privacy and telemetry              | Any file                |
| [`spellcheck`](#spellcheck)                                                                     | Underline misspelled words in the prompt input with a [spell checker](/docs/en/interactive-mode#check-spelling-as-you-type) you install                                                                                          | Interface and terminal             | User or managed         |
| [`spinnerTipsEnabled`](#spinnertipsenabled)                                                     | Hide tips in the spinner while Claude works                                                                                                                                                                                 | Interface and terminal             | Any file                |
| [`spinnerTipsOverride`](#spinnertipsoverride)                                                   | Add your own tips to the spinner rotation, or replace the built-in tips                                                                                                                                                     | Interface and terminal             | Any file                |
| [`spinnerVerbs`](#spinnerverbs)                                                                 | Add or replace the verbs shown while a turn runs                                                                                                                                                                            | Interface and terminal             | Any file                |
| [`sshConfigs`](#sshconfigs)                                                                     | Add [SSH connections](/docs/en/desktop#pre-configure-ssh-connections-for-your-team) to the Desktop environment dropdown                                                                                                          | Remote, desktop, and notifications | User or managed         |
| [`sshHostAllowlist`](#sshhostallowlist)                                                         | Limit which hosts [Desktop SSH sessions](/docs/en/desktop#restrict-which-ssh-hosts-users-can-connect-to) can reach                                                                                                               | Remote, desktop, and notifications | Managed                 |
| [`statusLine`](#statusline)                                                                     | Run your own command to render a [status line](/docs/en/statusline) below the prompt                                                                                                                                             | Interface and terminal             | Any file                |
| [`strictKnownMarketplaces`](#strictknownmarketplaces)                                           | Allowlist the [marketplace](/docs/en/plugin-marketplaces) sources users can add and install from                                                                                                                                 | Plugins and skills                 | Managed                 |
| [`strictPluginOnlyCustomization`](#strictpluginonlycustomization)                               | Block [skills](/docs/en/skills), [agents](/docs/en/sub-agents), [hooks](/docs/en/hooks), and [MCP servers](/docs/en/mcp) from user and project sources                                                                                          | Plugins and skills                 | Managed                 |
| [`strictPluginOnlyCustomization.agents`](#strictpluginonlycustomization-agents)                 | Lock [agents](/docs/en/sub-agents) to plugin and managed sources                                                                                                                                                                 | Plugins and skills                 | Managed                 |
| [`strictPluginOnlyCustomization.hooks`](#strictpluginonlycustomization-hooks)                   | Lock [hooks](/docs/en/hooks) to plugin and managed sources                                                                                                                                                                       | Plugins and skills                 | Managed                 |
| [`strictPluginOnlyCustomization.mcp`](#strictpluginonlycustomization-mcp)                       | Lock [MCP servers](/docs/en/mcp) to plugin and managed sources                                                                                                                                                                   | Plugins and skills                 | Managed                 |
| [`strictPluginOnlyCustomization.skills`](#strictpluginonlycustomization-skills)                 | Lock [skills](/docs/en/skills) to plugin and managed sources                                                                                                                                                                     | Plugins and skills                 | Managed                 |
| [`subagentPromptCacheTtl`](#subagentpromptcachettl)                                             | Choose the [prompt cache lifetime](/docs/en/prompt-caching#cache-lifetime) for subagents and other requests outside the main conversation                                                                                        | Model and responses                | Any file                |
| [`subagentStatusLine`](#subagentstatusline)                                                     | Rewrite rows in the [subagent](/docs/en/sub-agents) task display with your own command                                                                                                                                           | Interface and terminal             | Any file                |
| [`switchModelsOnFlag`](#switchmodelsonflag)                                                     | Switch models automatically or pause when a [safety classifier](/docs/en/model-config#ask-before-switching) flags a request                                                                                                      | Model and responses                | Any file                |
| [`syncClaudeAiSkills`](#syncclaudeaiskills)                                                     | Stop downloading the [skills enabled on your claude.ai account](/docs/en/skills#how-synced-skills-behave) and hide the ones already synced                                                                                       | Plugins and skills                 | User, local, or managed |
| [`syntaxHighlightingDisabled`](#syntaxhighlightingdisabled)                                     | Turn off syntax highlighting in diffs and code blocks                                                                                                                                                                       | Interface and terminal             | Any file                |
| [`teammateDefaultModel`](#teammatedefaultmodel)                                                 | Removed in v2.1.234; [teammates](/docs/en/agent-teams#specify-teammates-and-models) follow the lead's model                                                                                                                      | Global config settings             | Global config           |
| [`teammateMode`](#teammatemode)                                                                 | Choose how [agent team teammates display](/docs/en/agent-teams#choose-a-display-mode)                                                                                                                                            | Agents, sessions, and worktrees    | Any file                |
| [`terminalProgressBarEnabled`](#terminalprogressbarenabled)                                     | Hide the terminal progress bar in terminals that support it                                                                                                                                                                 | Interface and terminal
…[206956 chars omitted — read a slice]…
ed

This example locks skills and hooks and leaves agents and MCP servers unlocked:

```json managed-settings.json theme={null}
{
  "strictPluginOnlyCustomization": ["skills", "hooks"]
}
```

The four sub-key entries below list what each surface blocks and what still loads. Claude Code ignores surface names it doesn't recognize rather than failing the settings file, so you can add new surface names before every client has updated.

### `strictPluginOnlyCustomization.skills`

Lock the `skills` surface. Claude Code stops loading skills from `~/.claude/skills/` and `.claude/skills/`, custom commands from `~/.claude/commands/` and `.claude/commands/`, skills under `--add-dir` directories, and skills synced from your claude.ai account, and keeps loading plugin skills, bundled skills, and skills in the managed policy directory.

* **Scope**: [`Managed`](#scopes)
* **Type**: the string `"skills"` in the [`strictPluginOnlyCustomization`](#strictpluginonlycustomization) array
* **Default**: not locked

```json managed-settings.json theme={null}
{
  "strictPluginOnlyCustomization": ["skills"]
}
```

### `strictPluginOnlyCustomization.agents`

Lock the `agents` surface. Claude Code stops loading agents from `~/.claude/agents/` and `.claude/agents/`, and keeps loading plugin agents, built-in agents, and agents in the managed policy directory.

* **Scope**: [`Managed`](#scopes)
* **Type**: the string `"agents"` in the [`strictPluginOnlyCustomization`](#strictpluginonlycustomization) array
* **Default**: not locked

```json managed-settings.json theme={null}
{
  "strictPluginOnlyCustomization": ["agents"]
}
```

### `strictPluginOnlyCustomization.hooks`

Lock the `hooks` surface. Claude Code stops running hooks from user, project, and local `settings.json`, and keeps running plugin hooks and hooks in managed settings.

* **Scope**: [`Managed`](#scopes)
* **Type**: the string `"hooks"` in the [`strictPluginOnlyCustomization`](#strictpluginonlycustomization) array
* **Default**: not locked

```json managed-settings.json theme={null}
{
  "strictPluginOnlyCustomization": ["hooks"]
}
```

### `strictPluginOnlyCustomization.mcp`

Lock the `mcp` surface. Claude Code stops loading MCP servers from `~/.claude.json` and `.mcp.json`, and keeps loading plugin MCP servers and [`managed-mcp.json`](/docs/en/managed-mcp) servers.

* **Scope**: [`Managed`](#scopes)
* **Type**: the string `"mcp"` in the [`strictPluginOnlyCustomization`](#strictpluginonlycustomization) array
* **Default**: not locked

```json managed-settings.json theme={null}
{
  "strictPluginOnlyCustomization": ["mcp"]
}
```

### `enabledPlugins`

Turn individual [plugins](/docs/en/plugins) on or off, keyed by `plugin-name@marketplace-name`. A plugin with no entry at any scope falls back to its [`defaultEnabled`](/docs/en/plugins-reference#default-enablement) value. When you enable or disable a plugin with `/plugin` or `claude plugin enable`, Claude Code writes this key for you.

* **Scope**: [`Any file`](#scopes)
* **Type**: object mapping `plugin-name@marketplace-name` to a Boolean
* **Default**: unset, so each plugin follows its `defaultEnabled` value

This example enables two plugins from the `team-tools` marketplace and disables one from `personal`:

```json settings.json theme={null}
{
  "enabledPlugins": {
    "code-formatter@team-tools": true,
    "deployment-tools@team-tools": true,
    "experimental-features@personal": false
  }
}
```

Each scope serves a different purpose:

* **User settings**: your personal plugin preferences
* **Project settings**: plugins shared with everyone in the repository
* **Local settings**: per-machine overrides, gitignored when Claude Code saves a setting there
* **Managed settings**: organization-wide policy. A plugin set to `false` here is blocked from installation at every scope and hidden from the marketplace

Project settings take precedence over user settings, so setting a plugin to `false` in `~/.claude/settings.json` doesn't disable a plugin that the project's `.claude/settings.json` enables. To opt out of a project-enabled plugin on your machine, set it to `false` in `.claude/settings.local.json` instead. Plugins force-enabled by managed settings can't be disabled this way, since managed settings override local settings.

Enabling a plugin from an external source such as a GitHub repository or npm package in a project's `.claude/settings.json` doesn't install it for other people. On every path that loads plugins, Claude Code reports the plugin as not installed until each user [installs it themselves](/docs/en/discover-plugins#configure-team-marketplaces).

### `extraKnownMarketplaces`

Register additional plugin marketplaces by name, so that people who open the repository, or everyone your managed settings reach, get the marketplace without adding it themselves. Claude Code registers each marketplace it doesn't already know. Whether a plugin that [`enabledPlugins`](#enabledplugins) names from it installs depends on the plugin's source and which file enables it; that entry has the rules.

* **Scope**: [`Any file`](#scopes). Claude Code honors entries in a repository's `.claude/settings.json` or `.claude/settings.local.json` only after you accept the workspace trust dialog for that folder; in a folder you haven't trusted, including a `-p` run there, it ignores them without a message.
* **Type**: object mapping a marketplace name to an object with a `source` object and an optional `autoUpdate` Boolean
* **Default**: unset

This example registers a GitHub marketplace and a marketplace from a self-hosted git URL:

```json settings.json theme={null}
{
  "extraKnownMarketplaces": {
    "acme-tools": {
      "source": {
        "source": "github",
        "repo": "acme-corp/claude-plugins"
      }
    },
    "security-plugins": {
      "source": {
        "source": "git",
        "url": "https://git.example.com/security/plugins.git"
      }
    }
  }
}
```

[What runs before you trust a folder](/docs/en/permissions#what-runs-before-you-trust-a-folder) compares the trust gate with the other content a repository can supply. You can also write this key as `additionalMarketplaces`; see [Marketplace key aliases](#marketplace-key-aliases).

Set `"autoUpdate": true` alongside `source` to make Claude Code refresh that marketplace and update its installed plugins in the background after startup. When omitted, `claude-plugins-official` and most other official Anthropic marketplaces default to `true`, and third-party marketplaces default to `false`. See [Configure auto-updates](/docs/en/discover-plugins#configure-auto-updates).

When more than one settings file defines a marketplace entry under the same name, Claude Code uses the entry from the [highest-precedence file](/docs/en/settings#settings-precedence) whole. That entry replaces the lower-precedence entry and inherits none of its fields, so a redefinition can't combine one file's `source.headers` credential with a URL another file controls. Before v2.1.228, Claude Code merged same-name entries field by field, so an entry in a higher-precedence file could inherit fields it didn't set, including another file's `headers`.

#### Marketplace source types

The `source` object takes one of these forms:

* **`github`**: a GitHub repository, with `repo`
* **`git`**: any git URL, with `url`
* **`url`**: a direct URL to a `marketplace.json` file, with `url` and optional `headers` and `headersHelper` for authenticated access. `headersHelper` names a command that prints headers whose values are too short-lived to list in `headers`, and requires Claude Code v2.1.238 or later
* **`file`**: a local path to a `marketplace.json` file, with `path`
* **`directory`**: a local filesystem path, with `path`, for development only
* **`settings`**: an inline marketplace declared directly in the settings file without a hosted repository, with `name` and `plugins`

The `git` source type works with any git hosting service, including self-hosted GitLab and Bitbucket. Claude Code clones the repository with the same authentication that `git clone` would use on that machine: configured credential helpers or SSH keys. A provider token such as `GITHUB_TOKEN` takes effect only through a credential helper that reads it. See [Private repositories](/docs/en/plugin-marketplaces#private-repositories) for setup details.

For `github` and `git` sources, set `"skipLfs": true` inside the `source` object, alongside `repo` or `url`, to skip Git LFS downloads when Claude Code clones or updates the marketplace repository. LFS pointer files remain as pointers instead of downloading their content. Use this when the repository contains large LFS objects unrelated to plugin content.

For a `url` source, set `headersHelper` inside the `source` object when the credential in `headers` expires and a command has to produce a fresh one. Requires Claude Code v2.1.238 or later. For what the command must print and where Claude Code runs it, see [Write the headersHelper command](/docs/en/plugin-marketplaces#write-the-headershelper-command), and for the cases where Claude Code doesn't run it, see [When Claude Code skips a headersHelper command](/docs/en/plugin-marketplaces#when-claude-code-skips-a-headershelper-command-or-drops-its-output). Once you set `headersHelper` on an `https://` marketplace URL, Claude Code runs the command at two points, reusing one run's output for up to 60 seconds:

* Before each fetch of that marketplace's `marketplace.json`, including a later refresh. Claude Code sends the printed headers with that fetch.
* Before each plugin archive download on the marketplace URL's origin, meaning the same scheme, host, and port. Claude Code sends the output with that download, and no other download gets the headers.

Claude Code ignores any `headersHelper` set in the `.claude/settings.json` or `.claude/settings.local.json` of a directory you add with [`--add-dir`](/docs/en/permissions#what-runs-before-you-trust-a-folder), on a `url` source and on an inline plugin entry alike, and sends only the fixed `headers` set in that file. [How users accept a headersHelper command](/docs/en/plugin-marketplaces#how-users-accept-a-headershelper-command) covers the other settings files.

Plugins listed in a `settings` source must reference external sources such as GitHub or npm, and the `name` must match the marketplace key. You still enable each plugin separately in `enabledPlugins`. This example declares one plugin inline:

```json settings.json theme={null}
{
  "extraKnownMarketplaces": {
    "team-tools": {
      "source": {
        "source": "settings",
        "name": "team-tools",
        "plugins": [
          {
            "name": "code-formatter",
            "source": {
              "source": "github",
              "repo": "acme-corp/code-formatter"
            }
          }
        ]
      }
    }
  }
}
```

A plugin entry under `source: 'settings'` whose own `source` is an [`archive`](/docs/en/plugin-marketplaces#zip-archives) can set `headers` for the archive download. If the value you would put in `headers` is short-lived, such as a token your registry mints on request, set a `headersHelper` command instead. An entry may set both. Both fields require Claude Code v2.1.238 or later.

Claude Code sends the entry's `headers`, and whatever the command prints, with that plugin's archive download and with no other download. Claude Code runs the command only when a user [installs or updates that one plugin by itself](/docs/en/plugin-marketplaces#how-users-accept-a-headershelper-command). Three further rules depend on which file holds the entry:

* **`strict`**: unlike an entry in a marketplace's `marketplace.json`, an entry in settings doesn't need `"strict": false`, because a settings file carries no manifest fields to inline. See [Strict mode](/docs/en/plugin-marketplaces#strict-mode).
* **Folder trust**: for an entry in a project's `.claude/settings.json` or `.claude/settings.local.json`, Claude Code runs the command only after the user has also [trusted that folder](/docs/en/permissions#what-runs-before-you-trust-a-folder).
* **Header filter**: Claude Code drops [request-routing and client-identity header names](/docs/en/plugin-marketplaces#when-claude-code-skips-a-headershelper-command-or-drops-its-output) from an entry in a project's `.claude/settings.json` or `.claude/settings.local.json`, because a repository can supply those files. Claude Code applies the same filter to a catalog entry and to an entry in an `--add-dir` directory's settings, and no filter to an entry in your user settings, a `--settings` file, or managed settings.

#### Marketplace key aliases

On Claude Code v2.1.232 or later, you can write `extraKnownMarketplaces` as `additionalMarketplaces` and `strictKnownMarketplaces` as `allowedMarketplaces`. Claude Code treats each alias as follows:

* Earlier versions ignore the alias, so keep the canonical spelling in a file that older versions also read, such as a managed settings file for a fleet with mixed Claude Code versions.
* In any settings file that accepts the canonical key, Claude Code reads the alias exactly as it reads the canonical key.
* Claude Code may rewrite `additionalMarketplaces` to `extraKnownMarketplaces` when it updates the file.
* If you set both spellings in one file, Claude Code uses the canonical value and ignores the alias.

### `pluginConfigs`

Store the non-sensitive answers you give a plugin's [`userConfig`](/docs/en/plugins-reference#user-configuration) configuration dialog, keyed by plugin ID. Claude Code writes this key to your user settings when you fill in the dialog, so you don't need to edit it by hand. Sensitive options go to the macOS Keychain instead, or to `~/.claude/.credentials.json` on platforms without a supported keychain.

* **Scope**: [`User or managed`](#scopes)
* **Type**: object mapping a plugin ID to an object with an `options` field, mapping each option name to a string, number, Boolean, or array of strings, and an optional `mcpServers` field holding per-server user configuration values in the same shape
* **Default**: unset

This example stores the `api_endpoint` option for the `deployer` plugin from `acme-tools`:

```json settings.json theme={null}
{
  "pluginConfigs": {
    "deployer@acme-tools": {
      "options": {
        "api_endpoint": "https://api.example.com"
      }
    }
  }
}
```

Claude Code ignores project and local entries because it substitutes these values into plugin hook, MCP, and LSP configurations, and a cloned repository must not be able to supply them. Before v2.1.207, project and local settings were also read.

## MCP

Control which MCP servers Claude Code connects to and which an organization allows. See [Connect to external tools with MCP](/docs/en/mcp) and [Managed MCP configuration](/docs/en/managed-mcp).

### `allowAllClaudeAiMcps`

Load the [claude.ai connectors](/docs/en/mcp#use-mcp-servers-from-claude-ai) Claude Code fetches itself alongside a deployed `managed-mcp.json`. Without this key, `managed-mcp.json` takes exclusive control of MCP servers and suppresses those connectors.

* **Scope**: [`Managed`](#scopes). Users can't re-enable connectors that exclusive control suppressed.
* **Type**: Boolean
  * `true`: Claude Code loads the claude.ai connectors alongside a deployed `managed-mcp.json`
  * `false`: a deployed `managed-mcp.json` takes exclusive control of MCP servers and suppresses the claude.ai connectors [Claude Code fetches itself](/docs/en/mcp#how-connectors-reach-claude-code)
* **Default**: `false`, so a deployed `managed-mcp.json` suppresses the claude.ai connectors Claude Code fetches itself

```json managed-settings.json theme={null}
{
  "allowAllClaudeAiMcps": true
}
```

[`allowedMcpServers`](#allowedmcpservers) and [`deniedMcpServers`](#deniedmcpservers) still apply to the connectors this key loads. Connectors delivered to a [cloud session](/docs/en/claude-code-on-the-web) whose host carries a `managed-mcp.json`, such as a self-hosted runner, stay suppressed. See [Allow claude.ai connectors alongside the managed set](/docs/en/managed-mcp#allow-claude-ai-connectors-alongside-the-managed-set).

### `allowedMcpServers`

Allowlist the MCP servers people can use. Claude Code blocks any server that doesn't match an entry wherever it's defined, including plugin servers, servers passed with `--mcp-config`, and servers from `managed-mcp.json`. Built-in servers such as Claude in Chrome, the `ide` server Claude Code connects to in a running [VS Code](/docs/en/vs-code#the-built-in-ide-mcp-server) or [JetBrains](/docs/en/jetbrains#the-built-in-ide-mcp-server) IDE, and servers the CLI itself configures are exempt from the allowlist, and the denylist still applies to them. In-process `type: "sdk"` servers, which the [app that started the session registers](/docs/en/mcp#how-connectors-reach-claude-code), are exempt from both lists.

* **Scope**: [`Any file`](#scopes). Entries from every file merge into one allowlist unless [`allowManagedMcpServersOnly`](#allowmanagedmcpserversonly) is set. Deploy it in managed settings to enforce it.
* **Type**: array of objects, each with exactly one key: `serverName`, a string limited to letters, numbers, hyphens, and underscores; `serverCommand`, an array of the command and its arguments matched exactly; or `serverUrl`, a URL pattern with `*` wildcards
* **Default**: unset, so every server is allowed; an empty array blocks every server

This example allows only the stdio server that the listed `npx` command starts:

```json settings.json theme={null}
{
  "allowedMcpServers": [
    { "serverCommand": ["npx", "-y", "@modelcontextprotocol/server-filesystem"] }
  ]
}
```

A [`deniedMcpServers`](#deniedmcpservers) entry takes precedence, so a server on both lists is blocked. Once the list contains any `serverCommand` entry, a stdio server must match a `serverCommand` entry, and once it contains any `serverUrl` entry, a remote server must match a `serverUrl` entry: a `serverName` match no longer admits that kind of server. See [Policy-based control with allowlists and denylists](/docs/en/managed-mcp#policy-based-control-with-allowlists-and-denylists).

### `allowManagedMcpServersOnly`

Make the managed allowlist the only one that applies. Claude Code then reads [`allowedMcpServers`](#allowedmcpservers) from managed settings alone and ignores allowlists in user, project, and local settings; [`deniedMcpServers`](#deniedmcpservers) still merges from every file, so users can still block servers for themselves. Administrators set it so a user's own settings can't broaden what the managed allowlist permits.

* **Scope**: [`Managed`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code reads `allowedMcpServers` from managed settings alone and ignores allowlists in user, project, and local settings
  * `false`: allowlists from every settings file merge
* **Default**: `false`, so allowlists from every settings file merge

This example locks the allowlist to managed settings and allows only the server named `github`:

```json managed-settings.json theme={null}
{
  "allowManagedMcpServersOnly": true,
  "allowedMcpServers": [
    { "serverName": "github" }
  ]
}
```

Users can still add MCP servers of their own; only servers that match the managed allowlist load. See [Restrict the allowlist to managed settings only](/docs/en/managed-mcp#restrict-the-allowlist-to-managed-settings-only).

### `deniedMcpServers`

Block specific MCP servers. Claude Code refuses to load a matching server wherever it's defined, including plugin servers, servers passed with `--mcp-config`, servers from `managed-mcp.json`, and the claude.ai connectors [it fetches itself](/docs/en/mcp#how-connectors-reach-claude-code). In-process `type: "sdk"` servers, which the app that started the session registers, are exempt.

* **Scope**: [`Any file`](#scopes). Entries from every file merge into one denylist, and [`allowManagedMcpServersOnly`](#allowmanagedmcpserversonly) doesn't change that. Deploy it in managed settings to enforce it.
* **Type**: array of objects, each with exactly one key: `serverName`, any non-empty string, so a claude.ai connector's display name such as `"claude.ai Slack"` works; `serverCommand`, an array of the command and its arguments matched exactly; or `serverUrl`, a URL pattern with `*` wildcards
* **Default**: unset, so no server is blocked; an empty array also blocks nothing

```json settings.json theme={null}
{
  "deniedMcpServers": [
    { "serverName": "filesystem" }
  ]
}
```

The denylist takes precedence over [`allowedMcpServers`](#allowedmcpservers), so a server on both lists is blocked. See [Policy-based control with allowlists and denylists](/docs/en/managed-mcp#policy-based-control-with-allowlists-and-denylists).

### `disableClaudeAiConnectors`

Turn off the [claude.ai MCP connectors](/docs/en/mcp#use-mcp-servers-from-claude-ai) [Claude Code fetches itself](/docs/en/mcp#how-connectors-reach-claude-code), so it neither fetches nor connects them. A `true` in any settings file applies: a checked-in project `.claude/settings.json` can opt a repository out of those connectors, but a project-level `false` can't override a user- or managed-level `true`. Requires Claude Code v2.1.182 or later.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code neither fetches nor connects those connectors
  * `false`: the same as unset; Claude Code fetches your connectors unless another settings file or `ENABLE_CLAUDEAI_MCP_SERVERS` turns them off
* **Default**: `false`, so Claude Code fetches your connectors
* **Per-session overrides**: [`ENABLE_CLAUDEAI_MCP_SERVERS`](/docs/en/env-vars) set to `false` turns connectors off for one session; whichever of the two turns them off, the other can't turn them back on

```json settings.json theme={null}
{
  "disableClaudeAiConnectors": true
}
```

Servers you pass explicitly with `--mcp-config` are unaffected. To block individual connectors instead of all of them, use [`deniedMcpServers`](#deniedmcpservers). See [Disable claude.ai connectors](/docs/en/mcp#disable-claude-ai-connectors). Requires Claude Code v2.1.182 or later.

### `disabledMcpjsonServers`

Reject specific servers defined in a project's `.mcp.json` file so Claude Code never connects them or asks you to approve them. A rejection in any settings file applies, including a project `.claude/settings.json` checked into the repository.

* **Scope**: [`Any file`](#scopes)
* **Type**: array of strings, the server names as they appear in `.mcp.json`
* **Default**: unset

```json settings.json theme={null}
{
  "disabledMcpjsonServers": ["filesystem"]
}
```

Claude Code writes this key to `.claude/settings.local.json` when you reject a server in the approval dialog. `claude mcp get <name>` shows a rejected server as `✘ Rejected (see disabledMcpjsonServers in settings)`. Rejection takes precedence over [`enabledMcpjsonServers`](#enabledmcpjsonservers) and [`enableAllProjectMcpServers`](#enableallprojectmcpservers).

### `enableAllProjectMcpServers`

Approve every MCP server defined in project `.mcp.json` files without a prompt. Claude Code writes this key to `.claude/settings.local.json` when you choose to approve all servers in the approval dialog.

* **Scope**: [`Any file`](#scopes). In a folder whose trust dialog you haven't accepted, Claude Code honors it from user settings, managed settings, and `--settings` and ignores it in the shared project file, both in the session and for `claude mcp list` and `claude mcp get`; [Project server approvals and workspace trust](/docs/en/mcp#project-server-approvals-and-workspace-trust) says when an untracked `.claude/settings.local.json` counts too.
* **Type**: Boolean
  * `true`: Claude Code approves every MCP server defined in project `.mcp.json` files without a prompt
  * `false`: Claude Code asks you to approve each server. In a trusted folder, a `false` in a higher-precedence file overrides a `true` in a lower one; in a folder you haven't trusted, a `true` in any honored file is enough
* **Default**: unset, so Claude Code asks you to approve each server

```json settings.json theme={null}
{
  "enableAllProjectMcpServers": true
}
```

A [`disabledMcpjsonServers`](#disabledmcpjsonservers) entry still rejects a server.

### `enabledMcpjsonServers`

Approve specific servers defined in project `.mcp.json` files so Claude Code connects them without asking. Claude Code writes this key to `.claude/settings.local.json` when you approve a server in the approval dialog.

* **Scope**: [`Any file`](#scopes). In a folder whose trust dialog you haven't accepted, Claude Code honors it from user settings, managed settings, and `--settings` and ignores it in the shared project file, both in the session and for `claude mcp list` and `claude mcp get`; [Project server approvals and workspace trust](/docs/en/mcp#project-server-approvals-and-workspace-trust) says when an untracked `.claude/settings.local.json` counts too.
* **Type**: array of strings, the server names as they appear in `.mcp.json`
* **Default**: unset

This example approves the `memory` and `github` servers from the project's `.mcp.json`:

```json settings.json theme={null}
{
  "enabledMcpjsonServers": ["memory", "github"]
}
```

A [`disabledMcpjsonServers`](#disabledmcpjsonservers) entry still rejects a server.

## Agents, sessions, and worktrees

Set the default agent, control teammates and cross-session messaging, and configure worktrees. See [Subagents](/docs/en/sub-agents) and [Worktrees](/docs/en/worktrees).

### `agent`

Run the main thread as a named [subagent](/docs/en/sub-agents#invoke-subagents-explicitly), so Claude Code applies that subagent's system prompt, tool restrictions, and model to your session. The same key sets the default agent for sessions you dispatch from `claude agents`.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, the name of a built-in or custom agent
* **Default**: unset, so the main thread runs as Claude Code's default agent
* **Per-session overrides**: `--agent` takes precedence over this key for one session

```json settings.json theme={null}
{
  "agent": "code-reviewer"
}
```

A plugin's own `settings.json` can also supply this key; see [Ship default settings with your plugin](/docs/en/plugins#ship-default-settings-with-your-plugin).

### `crossSessionInbound`

Choose what this session does with [messages arriving from your other Claude Code sessions](/docs/en/cross-session-messaging#control-inbound-messages). When no value applies, Claude Code decides per message from the two sessions' permission-mode classes. Requires Claude Code v2.1.224 or later.

* **Scope**: [`Any file`](#scopes). A project or local value applies only when it's stricter than the value managed settings, the `--settings` flag, or user settings give.
* **Type**: string, one of:
  * `"accept"`: Claude Code delivers the message to Claude
  * `"hold"`: Claude Code shows a notice for the message without delivering it
  * `"refuse"`: Claude Code drops the message
* **Default**: unset, so Claude Code decides per message

```json settings.json theme={null}
{
  "crossSessionInbound": "hold"
}
```

Claude Code reads managed settings first, then the `--settings` flag, then user settings, and applies the first value found. `refuse` is stricter than `hold`, and `hold` is stricter than `accept`. When none of the trusted sources sets a value, a project or local `hold` or `refuse` still applies, replacing the per-message default. In sessions with cross-session messaging, this key appears in `/config` as **Messages from your other sessions**, which writes it to user settings; the row requires Claude Code v2.1.232 or later, and Claude Code hides it while the `--settings` flag or managed settings set the key.

Claude Code [warns](/docs/en/errors#crosssessioninbound-must-be-one-of-accept-hold-refuse) when you set a value it doesn't recognize. While that value is present in a user, project, local, or `--settings` file, Claude Code holds inbound messages, even when a source that takes precedence sets `accept`. A `refuse` that another source sets still applies. Fix or remove the value to clear the hold.

When the unrecognized value is in [managed settings](/docs/en/managed-settings), Claude Code instead treats it as `refuse` until an administrator fixes it. Before v2.1.248, Claude Code ignored an unrecognized value without warning.

### `disableAgentView`

Turn off [background agents and agent view](/docs/en/agent-view): `claude agents`, `--bg`, `/background`, and the on-demand supervisor. Set it in [managed settings](/docs/en/managed-settings) to enforce it for an organization.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code turns off `claude agents`, `--bg`, `/background`, and the on-demand supervisor
  * `false`: agent view is available
* **Default**: unset, so agent view is available
* **Per-session overrides**: [`CLAUDE_CODE_DISABLE_AGENT_VIEW`](/docs/en/env-vars) turns agent view off for one session; whichever of the two turns it off, the other can't turn it back on

```json settings.json theme={null}
{
  "disableAgentView": true
}
```

### `isolatePeerMachines`

Require your explicit approval before Claude's `SendMessage` reaches one of your sessions beyond this machine; see [Require approval for cross-machine messages](/docs/en/cross-session-messaging#require-approval-for-cross-machine-messages). The approval prompt appears even in [`bypassPermissions` mode](/docs/en/permission-modes#skip-all-checks-with-bypasspermissions-mode).

* **Scope**: [`Any file`](#scopes). A `true` from any scope applies, so a checked-in project file can turn the requirement on but not off.
* **Type**: Boolean
  * `true`: Claude Code asks for your approval before Claude's `SendMessage` reaches one of your sessions beyond this machine
  * `false`: cross-machine messages don't prompt
* **Default**: unset, so cross-machine messages don't prompt

```json settings.json theme={null}
{
  "isolatePeerMachines": true
}
```

The cross-machine `SendMessage` approval requires Claude Code v2.1.224 or later.

### `processWrapper`

On macOS and Linux, place a corporate launcher command in front of the [background processes Claude Code starts](/docs/en/corporate-launcher#what-the-launcher-covers). Claude Code runs the launcher with its own command line appended, so the launcher must exec into Claude Code; see [Run Claude Code behind a corporate launcher](/docs/en/corporate-launcher) for the launcher contract. Requires Claude Code v2.1.210 or later.

* **Scope**: [`User or managed`](#scopes)
* **Type**: string, the launcher command as an argv prefix, such as an absolute path with optional arguments
* **Default**: unset, so background processes start unwrapped
* **Per-session overrides**: [`CLAUDE_CODE_PROCESS_WRAPPER`](/docs/en/env-vars) takes precedence over this key for one session

```json settings.json theme={null}
{
  "processWrapper": "/opt/corp/launcher --profile claude"
}
```

Claude Code ignores the launcher on Windows and starts every process unwrapped. Requires Claude Code v2.1.210 or later.

### `teammateMode`

Choose where Claude Code shows [agent team](/docs/en/agent-teams) teammates: inside your main terminal pane, or in split panes when your terminal supports them. See [Choose a display mode](/docs/en/agent-teams#choose-a-display-mode).

* **Scope**: [`Any file`](#scopes). Claude Code also reads a value left in `~/.claude.json` by older versions.
* **Type**: string, one of:
  * `"in-process"`: teammates run inside your main terminal pane
  * `"auto"`: split panes when you're running inside tmux, or inside iTerm2 with `it2` on your `PATH` or tmux installed; in-process otherwise
  * `"tmux"`: split panes using tmux or iTerm2, detected from your terminal
  * `"iterm2"`: iTerm2 native split panes through the `it2` CLI, in Claude Code v2.1.186 or later
* **Default**: `"in-process"`
* **Per-session overrides**: `--teammate-mode` takes precedence over this key for one session

```json settings.json theme={null}
{
  "teammateMode": "auto"
}
```

Before v2.1.179, the default was `auto`. The `iterm2` value requires Claude Code v2.1.186 or later.

<span id="worktree-settings" />

### `worktree`

Configure how Claude Code creates and manages [git worktrees](/docs/en/worktrees) for `--worktree`, the `EnterWorktree` tool, and isolated subagents and background sessions.

* **Scope**: [`Any file`](#scopes)
* **Type**: object with `baseRef`, `symlinkDirectories`, `sparsePaths`, and `bgIsolation`
* **Default**: unset

This example branches new worktrees from your current `HEAD` and symlinks `node_modules` into each one:

```json settings.json theme={null}
{
  "worktree": {
    "baseRef": "head",
    "symlinkDirectories": ["node_modules"]
  }
}
```

To copy gitignored files like `.env` into new worktrees, add a [`.worktreeinclude` file](/docs/en/worktrees#copy-gitignored-files-into-worktrees) to your project root instead of a setting.

### `worktree.baseRef`

Choose which ref new worktrees branch from. `"fresh"` branches from `origin/<default-branch>` for a clean tree matching the remote; `"head"` branches from your current local `HEAD`, so unpushed commits and feature-branch state are present in the worktree.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, one of:
  * `"fresh"`: new worktrees branch from `origin/<default-branch>`
  * `"head"`: new worktrees branch from your current local `HEAD`, including unpushed commits
* **Default**: `"fresh"`

```json settings.json theme={null}
{
  "worktree": {
    "baseRef": "head"
  }
}
```

Inside a linked worktree, `"head"` resolves to that worktree's `HEAD`, not the main checkout's.

### `worktree.symlinkDirectories`

Symlink directories from the main repository into each worktree so you don't duplicate large directories on disk.

* **Scope**: [`Any file`](#scopes)
* **Type**: array of strings, directory paths relative to the repository root
* **Default**: unset, so Claude Code symlinks no directories

This example symlinks `node_modules` and `.cache` from the main repository into every new worktree:

```json settings.json theme={null}
{
  "worktree": {
    "symlinkDirectories": ["node_modules", ".cache"]
  }
}
```

### `worktree.sparsePaths`

Check out only the listed directories in each worktree through git sparse-checkout. Claude Code writes only those directories plus root-level files to disk, which is faster in large monorepos; see [Check out only the directories you need](/docs/en/large-codebases#check-out-only-the-directories-you-need).

* **Scope**: [`Any file`](#scopes)
* **Type**: array of strings, directory paths relative to the repository root
* **Default**: unset, so each worktree checks out the whole tree

This example checks out only `packages/my-app` and `shared/utils`, plus root-level files, in each worktree:

```json settings.json theme={null}
{
  "worktree": {
    "sparsePaths": ["packages/my-app", "shared/utils"]
  }
}
```

While a sparse worktree exists, git enables `extensions.worktreeConfig` in the repository's shared `.git/config`.

### `worktree.bgIsolation`

Choose how [background sessions](/docs/en/agent-view#how-file-edits-are-isolated) isolate their file edits. With `"worktree"`, Claude Code blocks `Edit` and `Write` in the main checkout until the session calls `EnterWorktree`; with `"none"`, background jobs edit the working copy directly. Set `"none"` for a repository where git worktrees are impractical.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, one of:
  * `"worktree"`: Claude Code blocks `Edit` and `Write` in the main checkout until the session calls `EnterWorktree`
  * `"none"`: background jobs edit the working copy directly
* **Default**: `"worktree"`

```json settings.json theme={null}
{
  "worktree": {
    "bgIsolation": "none"
  }
}
```

Outside a git repository, a [`WorktreeCreate` hook](/docs/en/worktrees#non-git-version-control) that fails releases the block so the session can edit the working directory in place; that release requires Claude Code v2.1.203 or later.

## Remote, desktop, and notifications

Configure Remote Control, cloud environments, the desktop app, and the notifications Claude Code sends when it needs you. See [Remote Control](/docs/en/remote-control).

### `agentPushNotifEnabled`

Allow Claude to send a push notification to your phone when it decides one is worth sending, for example when a long task finishes. Claude Code syncs this choice to your account, and pushes arrive while [Remote Control](/docs/en/remote-control) is connected. Appears in `/config` as **Push when Claude decides**.

* **Scope**: [`Any file`](#scopes). Claude Code also reads a value left in `~/.claude.json` by older versions.
* **Type**: Boolean
  * `true`: Claude can send a push notification to your phone when it decides one is worth sending
  * `false`: Claude doesn't send those notifications
* **Default**: `false`

```json settings.json theme={null}
{
  "agentPushNotifEnabled": true
}
```

See [Mobile push notifications](/docs/en/remote-control#mobile-push-notifications).

### `awaySummaryEnabled`

Show a one-line session recap when you return to the terminal after a few minutes away. Set it to `false`, or turn off **Session recap** in `/config`, to stop the recap.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: you see a one-line session recap when you return after a few minutes away
  * `false`: Claude Code shows no recap
* **Default**: unset, so the recap is on
* **Per-session overrides**: [`CLAUDE_CODE_ENABLE_AWAY_SUMMARY`](/docs/en/env-vars) takes precedence over this key for one session, in either direction

```json settings.json theme={null}
{
  "awaySummaryEnabled": false
}
```

Claude Code never shows the recap in non-interactive mode.

### `disableArtifact`

<Warning>
  Deprecated, and replaced by [`enableArtifact`](#enableartifact). Claude Code still honors `disableArtifact: true` as equivalent to `enableArtifact: false`, and ignores `disableArtifact: false`.
</Warning>

Use [`enableArtifact`](#enableartifact) instead to turn off the [Artifact](/docs/en/artifacts) tool, which publishes session output as a private web page on claude.ai. When you turn the **Artifacts** row off in `/config`, Claude Code writes `enableArtifact` to your user settings and clears this key.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code turns the Artifact tool off for every session the file applies to, and no other file turns it back on. Before v2.1.242, a higher-precedence file could override a lower file's `true` rather than the key acting as a lock
  * `false`: ignored; to leave the tool on, remove the key
* **Default**: unset, so the tool follows your account's [availability](/docs/en/artifacts#availability)
* **Per-session overrides**: [`CLAUDE_CODE_DISABLE_ARTIFACT`](/docs/en/env-vars) set to `1` turns the tool off for one session

```json settings.json theme={null}
{
  "disableArtifact": true
}
```

[Disable artifacts](/docs/en/artifacts#disable-artifacts) lists every way to turn the tool off.

### `disableDeepLinkRegistration`

Stop Claude Code from registering the `claude-cli://` protocol handler with the operating system, which it otherwise does after you send the first prompt of an interactive session. [Deep links](/docs/en/deep-links) let external tools open a Claude Code session with a pre-filled prompt. Set this in environments where protocol handler registration is restricted or managed separately.

* **Scope**: [`Any file`](#scopes)
* **Type**: the string `"disable"`
* **Default**: unset, so Claude Code registers the handler

```json settings.json theme={null}
{
  "disableDeepLinkRegistration": "disable"
}
```

### `disableDesktopLocalSessions`

Turn off Code sessions that run on the device in the [desktop app](/docs/en/desktop#local-sessions-on-managed-devices), for deployments where developers should work on remote machines over SSH. In the Code tab, the **Local** environment stays in the environment dropdown but is grayed out and can't be selected, with a tooltip saying your organization turned it off; on Windows the WSL entry is grayed out the same way, though whether WSL sessions run on a managed device at all is [governed separately](/docs/en/admin-setup#wsl-sessions-in-claude-code-desktop). New sessions default to the first [SSH connection](/docs/en/desktop#ssh-sessions) if one is configured, and the app refuses to start or resume a session on the device, including an SSH connection back to the same machine. SSH sessions to other hosts and cloud sessions are unaffected. The desktop app reads this key; the terminal CLI ignores it. Requires Claude Desktop v1.37937.0 or later.

* **Scope**: [`Managed`](#scopes)
* **Type**: Boolean; only the JSON Boolean `true` takes effect
  * `true`: the desktop app offers no on-device Code sessions; existing local sessions stay listed but can't continue
  * `false`: local sessions stay available
* **Default**: unset, so local sessions are available

```json managed-settings.json theme={null}
{
  "disableDesktopLocalSessions": true
}
```

The desktop app ignores any other value, and a value that isn't a Boolean, such as the string `"true"` or `1`, also logs a warning. Pair it with [`sshConfigs`](#sshconfigs) so users land on a working connection, and with [`sshHostAllowlist`](#sshhostallowlist) to limit which hosts they can reach. See [Local sessions on managed devices](/docs/en/desktop#local-sessions-on-managed-devices).

Claude Desktop supplies Code sessions with policy derived from your desktop configuration, for example the egress allowlist, filesystem sandbox, and MCP restrictions in third-party deployments. Claude Code ignores those parent settings whenever an [admin source](/docs/en/managed-settings#how-claude-code-combines-managed-sources) is present: server-managed settings, an MDM or OS-level policy, or a managed settings file. Deploying this key through one of those on a device that had none before, as in third-party deployments, therefore stops the desktop-derived policies from applying. [Let an embedding host add policy](/docs/en/managed-settings#let-an-embedding-host-add-policy) covers when parent settings can still merge; this holds for any key you deploy that way, not only this one.

### `disableRemoteControl`

Turn off [Remote Control](/docs/en/remote-control): Claude Code then refuses `claude remote-control`, the `--remote-control` flag, auto-start, and the in-session toggle, and reports that your organization's policy disabled it. Place it in [managed settings](/docs/en/managed-settings) for per-device MDM enforcement.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code refuses `claude remote-control`, the `--remote-control` flag, auto-start, and the in-session toggle
  * `false`: Remote Control stays available
* **Default**: `false`

```json settings.json theme={null}
{
  "disableRemoteControl": true
}
```

### `enableArtifact`

Turn off the [Artifact](/docs/en/artifacts) tool, which publishes session output as a private web page on claude.ai. When you turn the **Artifacts** row off in `/config`, Claude Code writes this key to your user settings, so you don't usually edit it by hand. Requires Claude Code v2.1.196 or later.

* **Scope**: [`Any file`](#scopes). Every file can turn the tool off, and none can turn it back on.
* **Type**: Boolean
  * `false`: Claude Code turns the Artifact tool off for every session the file applies to
  * `true`: the same as leaving the key unset, because it never overrides a `false` from another file, from [`CLAUDE_CODE_DISABLE_ARTIFACT`](/docs/en/env-vars), or from your organization's [admin setting](/docs/en/artifacts#manage-artifacts-for-your-organization)
* **Default**: unset, so the tool follows your account's [availability](/docs/en/artifacts#availability)

```json settings.json theme={null}
{
  "enableArtifact": false
}
```

While a source other than your own user settings keeps the tool turned off, Claude Code hides the **Artifacts** row in `/config`, because turning it on there wouldn't change anything. [Disable artifacts](/docs/en/artifacts#disable-artifacts) lists every way to turn the tool off. Before v2.1.242, Claude Code ignored this key in project and local settings, and a file higher in the [precedence stack](/docs/en/settings#settings-precedence) could turn the tool back on over a lower file's off.

### `inputNeededNotifEnabled`

Get a push notification on your phone when a permission prompt or question is waiting for your input. Claude Code sends these only while [Remote Control](/docs/en/remote-control) is connected. Appears in `/config` as **Push when actions required**.

* **Scope**: [`Any file`](#scopes). Claude Code also reads a value left in `~/.claude.json` by older versions.
* **Type**: Boolean
  * `true`: you get a push notification on your phone when a permission prompt or question is waiting, while Remote Control is connected
  * `false`: Claude Code sends no such notifications
* **Default**: `false`

```json settings.json theme={null}
{
  "inputNeededNotifEnabled": true
}
```

See [Mobile push notifications](/docs/en/remote-control#mobile-push-notifications).

### `preferredNotifChannel`

Choose how Claude Code notifies you when a task completes or a permission prompt is waiting. Appears in `/config` as **Local notifications**.

* **Scope**: [`Any file`](#scopes). Claude Code also reads a value left in `~/.claude.json` by older versions.
* **Type**: string, one of:
  * `"auto"`: Claude Code sends a desktop notification in iTerm2, Ghostty, and Kitty, rings the bell in Terminal.app only when its audible bell is off, and does nothing elsewhere
  * `"terminal_bell"`: Claude Code rings the bell character in any terminal
  * `"iterm2"`: Claude Code sends an iTerm2 desktop notification
  * `"iterm2_with_bell"`: Claude Code sends an iTerm2 desktop notification and rings the bell
  * `"kitty"`: Claude Code sends a Kitty desktop notification
  * `"ghostty"`: Claude Code sends a Ghostty desktop notification
  * `"notifications_disabled"`: Claude Code sends no notification
* **Default**: `"auto"`

```json settings.json theme={null}
{
  "preferredNotifChannel": "terminal_bell"
}
```

With `"auto"`, Claude Code sends a desktop notification in iTerm2, Ghostty, and Kitty. In Terminal.app it rings the bell character only when you have turned Terminal's audible bell off, and in other terminals it does nothing. Set `"terminal_bell"` to ring the bell character in any terminal. See [Get a terminal bell or notification](/docs/en/terminal-config#get-a-terminal-bell-or-notification).

### `remote.defaultEnvironmentId`

Pick the default [cloud environment](/docs/en/cloud-environments) for cloud sessions you create from the CLI, such as with `claude --cloud`. Claude Code writes this key to your user settings when you pick an environment with [`/remote-env`](/docs/en/cloud-environments#select-an-environment-from-the-cli).

* **Scope**: [`Any file`](#scopes). For a self-hosted environment ID, user or managed settings, or the `--settings` flag only.
* **Type**: string, an environment ID such as `env_...` or `ccpool_...`
* **Default**: unset, so Claude Code uses the Anthropic-hosted environment when your list has one, and otherwise the first environment in your list that isn't a [Remote Control bridge environment](/docs/en/cloud-environments#the-default-environment), or the first environment when every one is a bridge environment
* **Per-session overrides**: `--environment` takes precedence over this key for the one cloud session it creates

```json settings.json theme={null}
{
  "remote": {
    "defaultEnvironmentId": "env_0123abcd"
  }
}
```

An Anthropic-hosted environment ID, which starts with `env_`, follows the standard settings precedence, so a value in a repository's project settings overrides your user-level pick. A [self-hosted environment](/docs/en/self-hosted-environments) ID, which starts with `ccpool_`, is honored only from user settings, managed settings, and the `--settings` flag; Claude Code ignores one in a repository's project or local settings, and `/remote-env` shows which value it ignored, so a checked-in file can't steer sessions onto a self-hosted environment you didn't choose.

### `remoteControlAtStartup`

Connect [Remote Control](/docs/en/remote-control) automatically when each interactive session starts, instead of waiting for `/remote-control`. Set it to `true` to turn auto-connect on, `false` to turn it off. Appears in `/config` as **Enable Remote Control for all sessions**.

* **Scope**: [`Any file`](#scopes). Claude Code also reads a value left in `~/.claude.json` by older versions.
* **Type**: Boolean
  * `true`: Claude Code connects Remote Control automatically when each interactive session starts
  * `false`: Claude Code waits for `/remote-control`
* **Default**: unset, so auto-connect follows your organization's admin default when one is set, and otherwise Claude Code's current default
* **Per-session overrides**: `--remote-control` turns Remote Control on for one session even when this key is `false`, and no flag turns it off for one session

```json settings.json theme={null}
{
  "remoteControlAtStartup": true
}
```

Claude Code ignores a `true` from project or local settings, so a repository can turn auto-connect off for its checkout but can't turn it on. For the full per-scope behavior, see [Enable Remote Control for all sessions](/docs/en/remote-control#enable-remote-control-for-all-sessions) and the [security keys where the stricter value applies](/docs/en/settings#security-keys-where-the-stricter-value-applies).

### `sshConfigs`

Add SSH connections to the [Desktop](/docs/en/desktop#pre-configure-ssh-connections-for-your-team) environment dropdown. Administrators use it to distribute shared connections to a team. Connections you define in managed settings show as managed, so users can select them but can't edit or delete them in the app.

* **Scope**: [`User or managed`](#scopes). The desktop app reads this key.
* **Type**: array of objects, each with required `id`, `name`, and `sshHost` and optional `sshPort` and `sshIdentityFile`
* **Default**: unset

This example adds one connection named `Dev VM` that connects to `user@dev.example.com`:

```json settings.json theme={null}
{
  "sshConfigs": [
    {
      "id": "dev-vm",
      "name": "Dev VM",
      "sshHost": "user@dev.example.com"
    }
  ]
}
```

### `sshHostAllowlist`

Limit the hosts a [Desktop SSH session](/docs/en/desktop#restrict-which-ssh-hosts-users-can-connect-to) can connect to. Only the Desktop app reads this key; the CLI doesn't. Patterns are case-insensitive: `*` matches any host, `*.example.com` matches `example.com` and every subdomain, and anything else is an exact match against the hostname after `~/.ssh/config` resolution. An empty array turns SSH sessions off.

* **Scope**: [`Managed`](#scopes)
* **Type**: array of hostname patterns
* **Default**: unset, so any host is allowed

This example allows `devboxes.example.com` and its subdomains, plus the exact host `bastion.example.com`:

```json managed-settings.json theme={null}
{
  "sshHostAllowlist": ["*.devboxes.example.com", "bastion.example.com"]
}
```

<span id="authentication-and-login" />

## Authentication and providers

Supply credentials through helper scripts and, for organizations, force a login method or organization. See [Authentication](/docs/en/authentication).

### `apiKeyHelper`

Run your own command to produce the credential Claude Code sends with model requests. Claude Code runs the command through the system shell, `/bin/sh` on macOS and Linux and `cmd` on Windows, and sends its output as both the `X-Api-Key` and `Authorization: Bearer` headers. Use it for dynamic or rotating credentials, such as short-lived tokens fetched from a vault.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, a shell command line
* **Default**: unset, so Claude Code doesn't run a helper

```json settings.json theme={null}
{
  "apiKeyHelper": "/bin/generate_temp_api_key.sh"
}
```

Claude Code caches the value and reruns the command after the interval you set with [`CLAUDE_CODE_API_KEY_HELPER_TTL_MS`](/docs/en/env-vars). In interactive sessions, when the command comes from project or local settings, Claude Code doesn't run it until you accept the workspace trust prompt. See [Credential management](/docs/en/authentication#credential-management).

### `awsAuthRefresh`

Run your own command, such as `aws sso login`, to refresh the credentials in your `.aws` directory when the ones Claude Code has for [Amazon Bedrock](/docs/en/amazon-bedrock) stop working. Claude Code checks the current credentials against STS first and runs the command only when that check fails, then reads the refreshed `.aws` directory.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, a shell command line
* **Default**: unset, so Claude Code doesn't refresh AWS credentials for you

```json settings.json theme={null}
{
  "awsAuthRefresh": "aws sso login --profile myprofile"
}
```

Use this key when your refresh flow writes to `.aws`; use [`awsCredentialExport`](#awscredentialexport) when it prints credentials instead. See [advanced credential configuration](/docs/en/amazon-bedrock#advanced-credential-configuration).

### `awsCredentialExport`

Run your own command that prints AWS credentials as JSON, so Claude Code can call [Amazon Bedrock](/docs/en/amazon-bedrock) with credentials that don't live in your `.aws` directory. Claude Code accepts the `aws sts` output shape and the flat `aws configure export-credentials` shape, and scopes the credentials to its own Bedrock client, so the shell commands Claude runs still see your ambient credentials.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, a shell command line
* **Default**: unset, so Claude Code uses the ambient AWS credential chain

```json settings.json theme={null}
{
  "awsCredentialExport": "/bin/generate_aws_grant.sh"
}
```

Unlike [`awsAuthRefresh`](#awsauthrefresh), Claude Code always runs this command when it's set, without checking the ambient credentials first. See [advanced credential configuration](/docs/en/amazon-bedrock#advanced-credential-configuration).

### `forceLoginMethod`

Restrict which kind of account people can log in with. Set `"claudeai"` to allow only claude.ai accounts, `"console"` to allow only Claude Console accounts, or `"gateway"` to send people to a [cloud gateway](/docs/en/claude-apps-gateway) instead of a first-party login. Administrators set it in managed settings and pair it with [`forceLoginOrgUUID`](#forceloginorguuid) to keep developers' claude.ai logins inside one organization.

* **Scope**: [`Any file`](#scopes). Claude Code honors `"gateway"` only from a managed source on the machine: `managed-settings.json`, the macOS plist or Windows HKLM registry, or a policy helper. It treats `"gateway"` as unset in user, project, local, HKCU, and server-managed settings, the same rule as [`forceLoginGatewayUrl`](#forcelogingatewayurl).
* **Type**: string, one of:
  * `"claudeai"`: only claude.ai accounts can log in
  * `"console"`: only Claude Console accounts can log in
  * `"gateway"`: Claude Code sends people to a cloud gateway instead of a first-party login
* **Default**: unset, so people pick a login method

```json settings.json theme={null}
{
  "forceLoginMethod": "claudeai"
}
```

Every first-party login path applies the restriction, including the [VS Code extension](/docs/en/vs-code), the Agent SDK, `claude setup-token`, and `/install-github-app`, except the terminal's interactive login screen, reached by `/login` or first-run onboarding, which pre-selects the method without enforcing it. Before v2.1.212, only terminal logins applied it. See [Restrict login to your organization](/docs/en/authentication#restrict-login-to-your-organization) for how each login path, environment credentials, and third-party providers are handled.

### `forceLoginGatewayUrl`

Set the gateway URL the `/login` Cloud gateway screen connects to, so people reach your [cloud gateway](/docs/en/claude-apps-gateway) without typing its address. The screen has no URL field: with this key set, it shows your gateway URL and connects when the person presses Enter; without it, it tells them to contact their IT administrator. When `forceLoginMethod` is unset, this key alone opens the Cloud gateway screen. `forceLoginMethod: "gateway"` also opens it and removes the login-method picker, and a `claudeai` or `console` value there takes precedence over this key. Set both keys so the screen connects instead of showing an error.

* **Scope**: [`Managed`](#scopes). Read only from a source on the machine: `managed-settings.json`, the macOS plist or Windows HKLM registry, or a policy helper. Claude Code ignores it in HKCU and server-managed settings.
* **Type**: string, a full URL including the scheme
* **Default**: unset, so the Cloud gateway screen shows an error telling people to contact their IT administrator

```json managed-settings.json theme={null}
{
  "forceLoginGatewayUrl": "https://claude-gateway.example.com"
}
```

A value that isn't a valid URL is dropped on its own; the rest of the managed settings file still applies. See [Set the gateway URL](/docs/en/claude-apps-gateway#set-the-gateway-url).

### `forceLoginOrgUUID`

From a managed source, require claude.ai account logins to belong to one Anthropic organization, a single UUID, or to any of several, an array. From any settings file, a single UUID also pre-selects that organization during a claude.ai or Claude Console login; an array pre-selects nothing.

* **Scope**: [`Any file`](#scopes). Only a managed source enforces the restriction; a single UUID in any other settings file pre-selects the organization during login without restricting it.
* **Type**: string, one UUID, or array of strings, several UUIDs
* **Default**: unset, so any organization can log in

This example accepts logins from either of two organizations without pre-selecting one:

```json managed-settings.json theme={null}
{
  "forceLoginOrgUUID": ["xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy"]
}
```

An empty array in a managed source blocks every login with a misconfiguration message, and so does a value Claude Code can't parse. See [Restrict login to your organization](/docs/en/authentication#restrict-login-to-your-organization) for how Claude Code treats Claude Console logins, the other login paths, and environment credentials.

### `gcpAuthRefresh`

Run your own command to refresh Google Cloud Application Default Credentials when Claude Code finds they've expired or can't be loaded, so [Google Cloud's Agent Platform](/docs/en/google-vertex-ai) requests keep working without you re-authenticating by hand.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, a shell command line
* **Default**: unset, so Claude Code's credential error tells you to run `gcloud auth application-default login` yourself

```json settings.json theme={null}
{
  "gcpAuthRefresh": "gcloud auth application-default login"
}
```

See [advanced credential configuration](/docs/en/google-vertex-ai#advanced-credential-configuration).

### `otelHeadersHelper`

Run your own command to generate the headers Claude Code sends with OpenTelemetry exports, for backends whose tokens rotate. Claude Code runs it at startup and periodically after that, and expects a JSON object of string header values on stdout.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, an executable path or a shell command line
* **Default**: unset, so Claude Code adds no helper-generated headers

```json settings.json theme={null}
{
  "otelHeadersHelper": "/bin/generate_otel_headers.sh"
}
```

Set the refresh interval with [`CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS`](/docs/en/env-vars). See [Dynamic headers](/docs/en/monitoring-usage#dynamic-headers) for the script requirements and where Claude Code reports a failing helper.

## Updates and versioning

Choose an update channel and, for organizations, pin the versions people can run. See [Update Claude Code](/docs/en/setup#update-claude-code).

### `autoUpdatesChannel`

Choose which [release channel](/docs/en/setup#configure-release-channel) background auto-updates and `claude update` follow. Set `"stable"` for a version that is typically about one week old and skips releases with major regressions, or `"latest"` for the most recent release.

* **Scope**: [`Any file`](#scopes). Set it in managed settings to enforce one channel across your organization.
* **Type**: string, one of:
  * `"latest"`: updates follow the most recent release
  * `"stable"`: updates follow a version that is typically about one week old and skips releases with major regressions
* **Default**: unset, so Claude Code follows `"latest"`

```json settings.json theme={null}
{
  "autoUpdatesChannel": "stable"
}
```

Claude Code writes `"stable"` to your user settings when you pick it under **Auto-update channel** in `/config`, and removes the key when you switch back to latest there. `claude install stable` and `claude install latest` also save the channel you name. Switching from `"latest"` to `"stable"` in `/config` asks whether to allow a downgrade or stay on your current version; staying sets [`minimumVersion`](#minimumversion). Homebrew installs ignore this key: the `claude-code` cask tracks stable and `claude-code@latest` tracks latest, and `claude update` defers to `brew upgrade`. To turn auto-updates off entirely, set [`DISABLE_AUTOUPDATER`](/docs/en/setup#disable-auto-updates) in `env`.

### `minimumVersion`

Keep background auto-updates and `claude update` from installing any version below this one, so moving to the `"stable"` channel doesn't downgrade you from a newer `"latest"` build. Claude Code writes this key for you when you choose to stay on your current version while switching channels in `/config`, and clears it when you switch back to `"latest"`.

* **Scope**: [`Any file`](#scopes). Set it in managed settings to pin an organization-wide minimum that user and project settings can't lower.
* **Type**: string, a version number such as `"2.1.100"`
* **Default**: unset, so updates can install any version the channel offers

This example follows the stable channel and refuses to install any version below 2.1.100:

```json settings.json theme={null}
{
  "autoUpdatesChannel": "stable",
  "minimumVersion": "2.1.100"
}
```

This key only constrains updates. To make Claude Code refuse to start below a version, use [`requiredMinimumVersion`](#requiredminimumversion) instead. See [Pin a minimum version](/docs/en/setup#pin-a-minimum-version).

### `requiredMaximumVersion`

Set the newest Claude Code version your organization allows to start. When the running version is newer, Claude Code exits at startup and tells the user to install an approved version through your organization's approved method; `claude install <version>` may also work. Requires Claude Code v2.1.163 or later.

* **Scope**: [`Managed`](#scopes). Claude Code gives no warning when it ignores the key elsewhere.
* **Type**: string, a version number such as `"2.1.150"`; a value that isn't a valid version is ignored
* **Default**: unset, so no ceiling applies

```json managed-settings.json theme={null}
{
  "requiredMaximumVersion": "2.1.150"
}
```

Background auto-updates and `claude update` skip versions above the ceiling, so an installation inside the range stays inside it. `claude update`, `claude install`, and `claude doctor` keep working above the ceiling so users can recover. Pair it with [`requiredMinimumVersion`](#requiredminimumversion) to enforce a range. Requires Claude Code v2.1.163 or later.

### `requiredMinimumVersion`

Set the oldest Claude Code version your organization allows to start. When the running version is older, Claude Code exits at startup and tells the user to update through your organization's approved method. The check runs at startup only, so a session that's already running continues. Requires Claude Code v2.1.163 or later.

* **Scope**: [`Managed`](#scopes). Claude Code gives no warning when it ignores the key elsewhere.
* **Type**: string, a version number such as `"2.1.150"`; a value that isn't a valid version is ignored
* **Default**: unset, so no floor applies

```json managed-settings.json theme={null}
{
  "requiredMinimumVersion": "2.1.150"
}
```

`claude update`, `claude install`, and `claude doctor` keep working below the floor so users can recover. Unlike [`minimumVersion`](#minimumversion), which only prevents downgrades, this key blocks startup. Pair it with [`requiredMaximumVersion`](#requiredmaximumversion) to enforce a range. Requires Claude Code v2.1.163 or later.

## Tools

Turn off specific tools in the [Claude Code desktop app](/docs/en/desktop). The terminal CLI ignores these keys. For the tools themselves, see [Tools available to Claude](/docs/en/tools-reference).

### `browserExternalPageTools`

Stop Claude from using its tools to read or act on external pages in the desktop app's [Browser pane](/docs/en/desktop#browse-external-sites). People in your organization can still open external sites themselves, and local dev server previews keep working with Claude's tools. The desktop app reads this key; the terminal CLI ignores it.

* **Scope**: [`Managed`](#scopes)
* **Type**: string, `"disabled"`; the desktop app also accepts `"disable"`, in either case
* **Default**: unset, so Claude's tools work on external pages

```json managed-settings.json theme={null}
{
  "browserExternalPageTools": "disabled"
}
```

Any other value leaves Claude's tools on, and a non-empty string that isn't one of the two accepted values logs a warning. To block external sites for people and Claude alike, set [`disableBrowserExternalNavigation`](#disablebrowserexternalnavigation) instead. See [Restrict external browsing for your organization](/docs/en/desktop#restrict-external-browsing-for-your-organization).

### `disableBrowserExternalNavigation`

Turn off external browsing in the desktop app's [Browser pane](/docs/en/desktop#browse-external-sites) for people and Claude alike. Localhost dev server previews keep working. The desktop app reads this key; the terminal CLI ignores it.

* **Scope**: [`Managed`](#scopes)
* **Type**: Boolean; only the JSON Boolean `true` takes effect
  * `true`: the desktop app turns off external browsing in the Browser pane for people and Claude alike; localhost previews keep working
  * `false`: external browsing stays on
* **Default**: unset, so external browsing is on

```json managed-settings.json theme={null}
{
  "disableBrowserExternalNavigation": true
}
```

The desktop app ignores any other value, and a value that isn't a Boolean, such as the string `"true"` or `1`, also logs a warning. To leave external browsing on but keep Claude's tools off external pages, set [`browserExternalPageTools`](#browserexternalpagetools) instead. See [Restrict external browsing for your organization](/docs/en/desktop#restrict-external-browsing-for-your-organization).

### `disableMobileSimulatorTools`

Block Claude's tools for the desktop app's [iOS Simulator pane](/docs/en/desktop-ios-simulator#turn-off-simulator-access). People keep manual use of the pane; only Claude's access is removed, and nobody can turn it back on from inside the app. The desktop app reads this key; the terminal CLI ignores it.

* **Scope**: [`Managed`](#scopes)
* **Type**: Boolean; only the JSON Boolean `true` takes effect
  * `true`: the desktop app blocks Claude's tools for the iOS Simulator pane
  * `false`: Claude's simulator tools follow each person's settings toggle in the desktop app
* **Default**: unset, so Claude's simulator tools follow each person's settings toggle in the desktop app

```json managed-settings.json theme={null}
{
  "disableMobileSimulatorTools": true
}
```

The desktop app ignores any other value, and a value that isn't a Boolean, such as the string `"true"` or `1`, also logs a warning.

<span id="data-and-privacy" />

## Privacy and telemetry

Control how long Claude Code keeps session data and what it sends. The switches that turn off usage metrics and error reports are environment variables, not settings keys: set `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` in the [`env`](#env) key or in the shell. [Telemetry services](/docs/en/data-usage#telemetry-services) says what each one stops. Two exceptions turn off from a settings file: [`feedbackDrafts`](#feedbackdrafts) below for Claude-drafted feedback, and [`feedbackSurveyRate`](#feedbacksurveyrate) below for the session survey.

### `cleanupPeriodDays`

Set how many days Claude Code keeps [session transcripts and other application data](/docs/en/claude-directory#cleaned-up-automatically) before deleting them. Claude Code runs the deletion as a background sweep after a session starts, as long as it can safely determine the retention period.

* **Scope**: [`Any file`](#scopes)
* **Type**: number of days, a whole number, minimum `1`
* **Default**: `30`

```json settings.json theme={null}
{
  "cleanupPeriodDays": 20
}
```

Setting `0` fails validation, so pick a large value such as `3650` for long retention. To stop Claude Code from writing transcripts at all, see [Plaintext storage](/docs/en/claude-directory#plaintext-storage).

### `feedbackDrafts`

Control [Claude-drafted feedback](/docs/en/tools-reference#sendfeedback-tool-behavior): whether Claude can queue feedback drafts for you to review, and whether Claude Code shows a card when Claude queues one.

* **Scope**: [`User or managed`](#scopes)
* **Type**: string, one of `"notify"`, `"quiet"`, or `"off"`
  * `"notify"`: Claude Code shows a card above the prompt when Claude queues a draft, up to [three cards in a session](/docs/en/tools-reference#what-you-see-when-claude-drafts) by default
  * `"quiet"`: Claude drafts without a card. You see the count of queued drafts in the prompt footer and review them in `/feedback`
  * `"off"`: Claude Code removes the SendFeedback tool, so Claude can't queue drafts
* **Default**: `"notify"`
* **Per-session overrides**: [`CLAUDE_CODE_SEND_FEEDBACK`](/docs/en/env-vars) set to `0` turns the feature off for one session

```json settings.json theme={null}
{
  "feedbackDrafts": "quiet"
}
```

Appears in `/config` as **Claude-drafted feedback**, which writes this key to your user settings. You see the `/config` row only in sessions [where Claude can draft feedback](/docs/en/tools-reference#sessions-without-claude-drafted-feedback); setting `"off"` doesn't hide it, so you can turn the feature back on from the same row. A value in managed settings takes precedence over your user setting, so when an administrator sets this key, the row shows the managed value and changing it has no effect. Claude Code ignores this key in project and local settings.

### `feedbackSurveyRate`

Set the probability that the [session quality survey](/docs/en/data-usage#session-quality-surveys) appears when a session is eligible for it. Set `0` to keep the survey from appearing.

* **Scope**: [`Any file`](#scopes)
* **Type**: number between `0` and `1`
* **Default**: unset, so Claude Code uses the rate Anthropic sets remotely, or its built-in rate of `0.005` on Amazon Bedrock, Google Cloud's Agent Platform, and Microsoft Foundry, which don't receive remote configuration
* **Per-session overrides**: [`CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY`](/docs/en/env-vars) set to `1` turns the survey off for one session whatever rate this key sets

```json settings.json theme={null}
{
  "feedbackSurveyRate": 0.05
}
```

The same rate applies to the survey in the VS Code extension.

### `skipWebFetchPreflight`

Skip the [WebFetch domain safety check](/docs/en/data-usage#webfetch-domain-safety-check), which sends each requested hostname to `api.anthropic.com` before fetching. Set `true` in environments that block traffic to Anthropic, such as Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry deployments with restrictive egress.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code skips the WebFetch domain safety check
  * `false`: the check runs before the first fetch to each hostname in a session, and again for a hostname whose earlier check was blocked or failed
* **Default**: unset, so the check runs before the first fetch to each hostname in a session

```json settings.json theme={null}
{
  "skipWebFetchPreflight": true
}
```

With the check skipped, WebFetch attempts any URL without consulting the blocklist, so pair it with [`WebFetch` permission rules](/docs/en/permissions#webfetch) if you need to restrict which domains Claude can reach.

<span id="managed-policy" />

## Enterprise and managed settings

Keys an organization uses to compute, refresh, and combine managed settings. See [Set up managed settings](/docs/en/admin-setup).

### `disableSideloadFlags`

Reject the `--plugin-dir`, `--plugin-url`, `--agents`, and `--mcp-config` CLI flags at startup, which users could otherwise pass to bypass [`strictKnownMarketplaces`](#strictknownmarketplaces) for a single run. Claude Code exits with an error naming the rejected flags, and applies the same check to surfaces that start the CLI with these flags internally, currently [Cowork](/docs/en/desktop) local sessions in the desktop app. In [cloud sessions](/docs/en/claude-code-on-the-web), Claude Code drops the MCP servers the server delivered through `--mcp-config`, other than in-process `type: "sdk"` entries, and starts the session. Requires Claude Code v2.1.193 or later.

* **Scope**: [`Managed`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code rejects `--plugin-dir`, `--plugin-url`, `--agents`, and `--mcp-config` at startup and exits with an error naming them, except that in cloud sessions it drops the MCP servers the server delivered through `--mcp-config`, other than in-process `type: "sdk"` entries, and starts the session
  * `false`: Claude Code accepts those flags
* **Default**: `false`

```json managed-settings.json theme={null}
{
  "disableSideloadFlags": true
}
```

Claude Code still accepts a `--mcp-config` whose servers are all in-process `type: "sdk"` entries, so the Agent SDK and VS Code extension keep working. Users can still add servers with `claude mcp add` or a `.mcp.json` file; for per-server control, set [`allowedMcpServers`](/docs/en/managed-mcp) as well. Requires Claude Code v2.1.193 or later.

In cloud sessions, Claude Code also ignores server-delivered mid-session MCP updates, the path behind cloud session configuration and SDK `setMcpServers()` on remote workers. In-process `type: "sdk"` entries stay exempt there too. Before v2.1.239, a server-delivered `--mcp-config` blocked a cloud session from starting.

### `forceRemoteSettingsRefresh`

Block CLI startup until Claude Code has freshly fetched [server-managed settings](/docs/en/server-managed-settings). If the fetch fails, Claude Code exits instead of continuing with cached or no settings. Set it when your environment can't accept even a brief window in which a session runs without its managed policy.

When the key is unset, Claude Code doesn't block startup on the fetch, though when the developer signs in at startup it waits up to five seconds for the fetch. A Cloud gateway session always waits, and exits if the gateway can't be reached.

* **Scope**: [`Managed`](#scopes). Claude Code honors a `true` from any admin-controlled managed source, even one that isn't the highest-priority source.
* **Type**: Boolean
  * `true`: Claude Code blocks startup until it has freshly fetched server-managed settings, and exits if the fetch fails
  * `false`: Claude Code doesn't block startup on the fetch, though at a sign-in startup it waits up to five seconds for the fetch
* **Default**: `false`

```json managed-settings.json theme={null}
{
  "forceRemoteSettingsRefresh": true
}
```

Set it in an MDM profile or the managed settings file to enforce fail-closed startup before the first server payload arrives. Claude Code applies the check only in sessions that fetch server-managed settings, so a session that [doesn't fetch them](/docs/en/server-managed-settings#platform-availability) starts without waiting. The `claude auth` subcommands are exempt, so users can re-authenticate when expired credentials are why the fetch fails. See [Enforce fail-closed startup](/docs/en/server-managed-settings#enforce-fail-closed-startup).

### `managedSourcesBehavior`

Choose whether Claude Code applies only the highest-priority [managed source](/docs/en/managed-settings#how-claude-code-combines-managed-sources) your organization delivers, or combines every admin source it delivers. By default Claude Code takes the highest-priority source that carries a [policy key](/docs/en/managed-settings#how-claude-code-combines-managed-sources) and ignores the rest. A policy key is any settings key other than this one and `wslInheritsWindowsSettings`. So once server-managed settings or an MDM policy deliver a policy key, a `managed-settings.json` file contributes only the [keys Claude Code reads from every admin source](/docs/en/managed-settings#keys-read-from-every-admin-source). With `"merge"`, every admin source you deliver contributes its keys to one combined policy. Requires Claude Code v2.1.242 or later.

Set `"merge"` only where every source [ranked](/docs/en/managed-settings#how-claude-code-combines-managed-sources) below your highest one is under an administrator's control, because Claude Code then adds entries from a lower source, such as `permissions.allow` rules, to the policy.

* **Scope**: [`Managed`](#scopes). Claude Code reads this key from the highest-priority source that carries either this key or a policy key, and ignores this key in every source ranked lower, so a lower source can't opt itself into combining with the source above it. Neither the Windows HKCU registry nor [parent settings from an embedding host](/docs/en/managed-settings#let-an-embedding-host-add-policy) take part in the merge.
* **Type**: string, one of:
  * `"first-wins"`: the highest-priority source that carries a policy key supplies the policy, and lower sources contribute only the [keys Claude Code reads from every admin source](/docs/en/managed-settings#keys-read-from-every-admin-source)
  * `"merge"`: every admin source you deliver contributes its keys, combined by the rules below
* **Default**: `"first-wins"`

Deliver the key in the highest-priority source you deploy. A machine that never receives server-managed settings needs the key in its MDM profile too, because Claude Code reads the key from the highest-priority source that carries it or a policy key. A `managed-settings.json` file is the lowest-ranked admin source, so `"merge"` set there has no source below it to combine with. In server-managed settings, the key looks like this:

```json theme={null}
{
  "managedSourcesBehavior": "merge"
}
```

Under `"merge"`, Claude Code combines each key by its kind. This table gives the rule for each kind; the restriction allowlist and highest-source-only rows name every key they cover, and the other rows give examples:

| Kind of key                                | How Claude Code combines it                                                                                                                                                             | Keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| :----------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lists                                      | Combines entries from every source                                                                                                                                                      | [`permissions.allow`](#permissions-allow), [`sandbox.network.allowedDomains`](#sandbox-network-alloweddomains), and other list keys                                                                                                                                                                                                                                                                                                                                                                    |
| Locks                                      | Applies the strictest value any source sets. When no source sets a strict value, applies a looser value only from the highest source                                                    | [`allowManagedPermissionRulesOnly`](#allowmanagedpermissionrulesonly), [`permissions.disableBypassPermissionsMode`](#permissions-disablebypasspermissionsmode), and other boolean or enum locks                                                                                                                                                                                                                                                                                                        |
| Restriction allowlists                     | Takes the list whole from the highest source that sets it, without adding entries from lower sources. When the highest source doesn't set one, takes it whole from the next source down | [`availableModels`](#availablemodels), [`allowedMcpServers`](#allowedmcpservers), [`strictKnownMarketplaces`](#strictknownmarketplaces), [`allowedChannelPlugins`](#allowedchannelplugins), and the [`fallbackModel`](#fallbackmodel) chain                                                                                                                                                                                                                                                            |
| Read from the highest-priority source only | Reads the key only from the highest-priority source that carries a policy key, so a lower source's value is ignored even when the highest source sets none                              | [`apiKeyHelper`](#apikeyhelper), [`awsAuthRefresh`](#awsauthrefresh), [`awsCredentialExport`](#awscredentialexport), [`gcpAuthRefresh`](#gcpauthrefresh), [`otelHeadersHelper`](#otelheadershelper), `proxyAuthHelper`, [`forceLoginOrgUUID`](#forceloginorguuid), [`forceLoginMethod`](#forceloginmethod), [`forceLoginGatewayUrl`](#forcelogingatewayurl), [`parentSettingsBehavior`](#parentsettingsbehavior), [`modelPicker`](#modelpicker), [`permissions.defaultMode`](#permissions-defaultmode) |
| `env`                                      | [Merges per variable across admin sources](/docs/en/managed-settings#keys-read-from-every-admin-source), under both `"first-wins"` and `"merge"`                                             | [`env`](#env)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Every other key                            | Takes the value from the highest source that sets it                                                                                                                                    | [`cleanupPeriodDays`](#cleanupperioddays), [`model`](#model)                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Two of those keys add a condition of their own:

* **[`modelOverrides`](#modeloverrides)**: pairs with `availableModels`. Claude Code takes `modelOverrides` from the highest source that sets it, unless a higher source sets `availableModels` without `modelOverrides`. In that case it ignores `modelOverrides` from every source.
* **[`forceLoginGatewayUrl`](#forcelogingatewayurl) and the `"gateway"` value of [`forceLoginMethod`](#forceloginmethod)**: Claude Code honors them only when the highest source is an MDM policy or a managed settings file, so under server-managed settings neither applies.

To confirm which sources combined on a machine, run `/status` and [read the `Setting sources` line](/docs/en/managed-settings#read-the-source-in-/status).

### `parentSettingsBehavior`

Choose whether Claude Code applies managed settings supplied by an embedding host process, such as the Agent SDK or an IDE extension, when an admin-deployed managed tier is also present. With `"first-wins"`, Claude Code drops the host-supplied settings; with `"merge"`, it applies them under the admin tier through a restrictive-only filter. Set `"merge"` when a host needs to pass its own restrictions to the sessions it launches, for example Claude Desktop delivering a gateway's egress allowlist.

* **Scope**: [`Managed`](#scopes). Claude Code reads it from the highest-priority admin-controlled managed source.
* **Type**: string, one of:
  * `"first-wins"`: Claude Code drops the host-supplied settings when an admin-deployed managed tier is present
  * `"merge"`: Claude Code applies the host-supplied settings under the admin tier through a restrictive-only filter
* **Default**: `"first-wins"`

```json managed-settings.json theme={null}
{
  "parentSettingsBehavior": "merge"
}
```

This key has no effect when no admin-deployed managed tier exists: the host's settings then apply as the only managed tier, still filtered to restrictive values. For the filter's limits and how the managed sources interact, see [Parent settings from embedding hosts](/docs/en/managed-settings#parent-settings-from-embedding-hosts) and [Restrict parent settings](/docs/en/claude-apps-gateway#restrict-parent-settings).

<span id="compute-managed-settings-with-a-policy-helper" />

### `policyHelper`

Run an executable you deploy that computes managed settings at startup, so you can derive policy from device posture, identity, or a remote service instead of a static file. Claude Code runs the helper before it accepts the first prompt and treats the settings it emits as the managed settings for the session.

* **Scope**: [`Managed`](#scopes). Read from the macOS plist, the Windows HKLM registry, or the managed settings file. Claude Code reads the key from the highest-priority managed source that delivers settings and runs the helper only when that source is one of those three; it ignores the key in server-managed settings, the HKCU registry, and host-supplied parent settings.
* **Type**: object with `path`, `timeoutMs`, and `refreshIntervalMs`
* **Default**: unset, so no helper runs

This example runs the helper with a 5-second timeout and re-runs it every five minutes:

```json managed-settings.json theme={null}
{
  "policyHelper": {
    "path": "/usr/local/bin/claude-policy",
    "timeoutMs": 5000,
    "refreshIntervalMs": 300000
  }
}
```

#### Write the helper output

Claude Code runs the helper with no arguments, sets `CLAUDE_CODE_VERSION` in its environment, and reads a JSON envelope from stdout, capped at 1 MB. Put the settings under a `managedSettings` key. A bare settings object with no `managedSettings` key parses with `managedSettings` undefined and applies nothing, and Claude Code reports no error:

```json theme={null}
{
  "managedSettings": {
    "permissions": { "deny": ["Read(//etc/secrets/**)"] }
  }
}
```

When the helper emits `managedSettings`, that object becomes the only managed settings source for the run: Claude Code ignores the MDM, file, and HKCU sources, reads the [cross-source keys](/docs/en/managed-settings#keys-read-from-every-admin-source) from the helper's output alone, and never merges [parent settings](/docs/en/managed-settings#parent-settings-from-embedding-hosts). The startup `forceRemoteSettingsRefresh` check runs before the helper and reads any admin source. A helper that exits 0 without emitting `managedSettings` contributes no managed settings, and the other sources apply as usual. When the helper exits non-zero at startup, Claude Code prints the error and refuses to start, so a helper that needs outage resilience should serve from its own cache and exit `0`.

### `policyHelper.path`

Name the helper executable Claude Code runs. Claude Code refuses to start when the path isn't absolute, or on Windows when it doesn't end in `.exe`.

* **Scope**: [`Managed`](#scopes). Read from the macOS plist, the Windows HKLM registry, or the managed settings file, wherever [`policyHelper`](#policyhelper) is read.
* **Type**: string, an absolute path in normalized form, without `.` or `..` segments
* **Default**: none; required when `policyHelper` is set

```json managed-settings.json theme={null}
{
  "policyHelper": {
    "path": "/usr/local/bin/claude-policy"
  }
}
```

### `policyHelper.timeoutMs`

Set how long Claude Code waits for the helper before treating the run as failed. A timed-out run fails the same way as a non-zero exit, so at startup Claude Code refuses to start.

* **Scope**: [`Managed`](#scopes). Read from the macOS plist, the Windows HKLM registry, or the managed settings file, wherever [`policyHelper`](#policyhelper) is read.
* **Type**: integer, milliseconds, minimum `1000`
* **Default**: `10000`

```json managed-settings.json theme={null}
{
  "policyHelper": {
    "path": "/usr/local/bin/claude-policy",
    "timeoutMs": 5000
  }
}
```

### `policyHelper.refreshIntervalMs`

Have Claude Code re-run the helper in the background on an interval so policy changes reach a running session. When a refresh succeeds, its output replaces the previous managed settings without a restart; when a refresh fails, Claude Code keeps the policy it already has.

* **Scope**: [`Managed`](#scopes). Read from the macOS plist, the Windows HKLM registry, or the managed settings file, wherever [`policyHelper`](#policyhelper) is read.
* **Type**: integer, milliseconds: `0` to disable refresh, otherwise at least `60000`
* **Default**: unset, so Claude Code runs the helper once at startup

This example re-runs the helper every five minutes:

```json managed-settings.json theme={null}
{
  "policyHelper": {
    "path": "/usr/local/bin/claude-policy",
    "refreshIntervalMs": 300000
  }
}
```

### `wslInheritsWindowsSettings`

Have Claude Code on WSL read managed settings from the Windows policy chain, with HKLM and the Windows managed settings file taking priority over `/etc/claude-code` and HKCU below it. While the chain is on, Claude Code reads `/etc/claude-code` only when no managed settings file or drop-in under `C:\Program Files\ClaudeCode\` delivers a [policy key](/docs/en/managed-settings#how-claude-code-combines-managed-sources). Set it to extend the policy you already deploy on Windows to WSL sessions on the same machine, so they follow the same rules as host sessions. Claude Code honors it only when set in the HKLM registry key or in a managed settings file or drop-in under `C:\Program Files\ClaudeCode\`, both of which require Windows admin to write.

* **Scope**: [`Managed`](#scopes). In an admin-controlled Windows source.
* **Type**: Boolean
  * `true`: Claude Code on WSL reads managed settings from the Windows policy chain, and reads `/etc/claude-code` only when no managed settings file or drop-in under `C:\Program Files\ClaudeCode\` delivers a [policy key](/docs/en/managed-settings#how-claude-code-combines-managed-sources)
  * `false`: WSL reads only `/etc/claude-code`
* **Default**: `false`, so WSL reads only `/etc/claude-code`

```json managed-settings.json theme={null}
{
  "wslInheritsWindowsSettings": true
}
```

Once an admin source turns the chain on, HKCU policy joins it on WSL only when HKCU also sets the key to `true`. That copy doesn't turn the chain on by itself. A Windows source that contains only this key doesn't count as a policy source, so a lower-priority source still supplies the policy. This key has no effect on native Windows.

## Global config settings

Save these keys in `~/.claude.json`, not in a settings file. Claude Code ignores them anywhere else. Claude Code and `/config` write most of them for you, and you can also edit them by hand.

### `autoConnectIde`

Connect to a running IDE automatically when you start Claude Code from an external terminal. Appears in `/config` as **Auto-connect to IDE (external terminal)** when you run Claude Code outside a VS Code or JetBrains terminal.

* **Scope**: [`Global config`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code connects to a running IDE automatically when you start it from an external terminal
  * `false`: Claude Code doesn't connect automatically from an external terminal; inside a VS Code or JetBrains terminal, or with `--ide`, it still connects
* **Default**: `false`
* **Per-session overrides**: [`CLAUDE_CODE_AUTO_CONNECT_IDE`](/docs/en/env-vars) takes precedence over this key for one session, in either direction

```json ~/.claude.json theme={null}
{
  "autoConnectIde": true
}
```

Claude Code ignores this key in `settings.json`.

### `autoInstallIdeExtension`

Install the Claude Code IDE extension automatically when you run Claude Code from a VS Code terminal. Appears in `/config` as **Auto-install IDE extension** when you run Claude Code inside a VS Code or JetBrains terminal.

* **Scope**: [`Global config`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code installs the IDE extension automatically when you run it from a VS Code terminal
  * `false`: Claude Code doesn't install the extension automatically
* **Default**: `true`
* **Per-session overrides**: [`CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL`](/docs/en/env-vars) set to `1` skips the install for one session even when this key is `true`

```json ~/.claude.json theme={null}
{
  "autoInstallIdeExtension": false
}
```

Claude Code ignores this key in `settings.json`.

### `diffTool`

Choose where Claude Code shows the diff of an `Edit` or `Write` change it proposes when a [VS Code](/docs/en/vs-code) or [JetBrains](/docs/en/jetbrains#features) IDE is connected: `"auto"` opens it in the IDE's diff viewer, `"terminal"` keeps it in the terminal. Appears in `/config` as **Diff tool** only while Claude Code is connected to a VS Code or JetBrains IDE.

* **Scope**: [`Global config`](#scopes)
* **Type**: string, one of:
  * `"auto"`: Claude Code opens the diff in the IDE's diff viewer when a VS Code or JetBrains IDE is connected
  * `"terminal"`: Claude Code keeps the diff in the terminal
* **Default**: `"auto"`

```json ~/.claude.json theme={null}
{
  "diffTool": "terminal"
}
```

Claude Code ignores this key in `settings.json`.

### `externalEditorContext`

When you press `Ctrl+G`, Claude Code opens the prompt you're typing in your [external editor](/docs/en/interactive-mode#general-controls). With this key on, the editor buffer starts with Claude's previous response as `#` comment lines, so you can read it while you write, and Claude Code strips those lines when you save. Appears in `/config` as **Show last response in external editor**.

* **Scope**: [`Global config`](#scopes)
* **Type**: Boolean
  * `true`: the editor buffer starts with Claude's previous response as `#` comment lines, which Claude Code strips when you save
  * `false`: the editor buffer opens with only your prompt
* **Default**: `false`

```json ~/.claude.json theme={null}
{
  "externalEditorContext": true
}
```

With it on, the buffer Claude Code opens looks like this, and only the text below the marker line is sent as your prompt:

```text theme={null}
# ─── Claude's last response (for reference; removed on save) ───
# I added the retry loop to fetchUser in src/api.ts and a test
# for the timeout case. Want me to wire the same retry into
# fetchOrders?
# ─── Write your reply below this line ──────────────────────────

Yes, and cap it at three attempts.
```

Claude Code keeps the last 50 lines of the response and marks the cut with `# … (earlier output truncated)`.

Claude Code ignores this key in `settings.json`.

### `permissionExplainerEnabled`

When Claude asks permission to run a Bash or PowerShell command, you can press `Ctrl+E` on the prompt to get a model-generated [explanation of the command](/docs/en/permissions#permission-system): what it does, why Claude is running it, and what could go wrong, labeled **Low risk**, **Med risk**, or **High risk**. Claude Code asks the model for the explanation only when you press the shortcut, and showing it doesn't run the command. Set this key to `false` to turn the shortcut off.

* **Scope**: [`Global config`](#scopes)
* **Type**: Boolean
  * `true`: you can press `Ctrl+E` on a Bash or PowerShell permission prompt to get a model-generated explanation of the command
  * `false`: Claude Code turns the `Ctrl+E` shortcut off
* **Default**: `true`

```json ~/.claude.json theme={null}
{
  "permissionExplainerEnabled": false
}
```

Claude Code ignores this key in `settings.json`.

### `teammateDefaultModel`

<Warning>
  Removed in v2.1.234, together with its `/config` row **Default teammate model**. Setting it has no effect on current versions.
</Warning>

Through v2.1.233, you set this key to the model for [agent team](/docs/en/agent-teams#specify-teammates-and-models) teammates your prompt didn't name a model for: an alias such as `"sonnet"`, or `null` to follow the lead's model. For the model Claude Code picks for such teammates now, see [specify teammates and models](/docs/en/agent-teams#specify-teammates-and-models).

* **Scope**: [`Global config`](#scopes). On v2.1.233 and earlier.
* **Type**: string, a model alias or full model ID, or `null`
* **Default**: unset

## See also

* [Configure permissions](/docs/en/permissions): rule syntax, permission modes, and workspace trust
* [Environment variables](/docs/en/env-vars): every `CLAUDE_*`, `ANTHROPIC_*`, and provider variable Claude Code reads
* [Tools available to Claude](/docs/en/tools-reference): the built-in tools and which need approval
* [Example settings files](/docs/en/settings-example): a personal file, a team file, and an organization's managed file
* [Set up managed settings](/docs/en/admin-setup): how organizations decide what to enforce
* [Deploy managed settings](/docs/en/managed-settings): delivery mechanisms, precedence within the managed tier, and invalid entries in managed settings
* [Debug your configuration](/docs/en/debug-your-config): `claude doctor` and the Settings Error dialog
