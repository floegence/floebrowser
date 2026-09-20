import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

export async function fixture() {
  const requests: Array<{ path: string; cookie: string; method: string }> = [];
  const submissions: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? '/';
      requests.push({
        path,
        cookie: request.headers.cookie ?? '',
        method: request.method ?? 'GET',
      });
      response.setHeader('Cache-Control', 'no-store');
      if (path === '/redirect') {
        response.writeHead(302, { Location: '/second' });
        response.end();
        return;
      }
      if (path === '/submit') {
        if (!request.headers.cookie?.includes('session=source-only')) {
          response.writeHead(401);
          response.end();
          return;
        }
        let body = '';
        for await (const chunk of request) body += chunk;
        submissions.push(body);
        response.setHeader('Content-Type', 'application/json');
        response.end('{"ok":true}');
        return;
      }
      if (path.startsWith('/private/')) {
        if (!request.headers.cookie?.includes('session=source-only')) {
          response.writeHead(401);
          response.end();
          return;
        }
        if (path === '/private/font.woff2') {
          response.setHeader('Content-Type', 'font/woff2');
          response.end(
            await readFile(
              new URL(
                '../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2',
                import.meta.url,
              ),
            ),
          );
          return;
        }
        if (path === '/private/brand.svg' || path === '/private/retina.svg') {
          response.setHeader('Content-Type', 'image/svg+xml');
          response.end(
            path === '/private/retina.svg'
              ? '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#5867e8"/></svg>'
              : '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" rx="14" fill="#1f775f"/><path d="M15 15h18v7H22v11h-7Z" fill="white"/></svg>',
          );
          return;
        }
        if (path === '/private/theme.css') {
          response.setHeader('Content-Type', 'text/css');
          response.end(
            '@font-face{font-family:FixtureInter;src:url("./font.woff2") format("woff2");font-weight:400}body{font-family:FixtureInter,Arial,sans-serif}.private-card{background-image:url("./brand.svg");background-repeat:no-repeat;background-position:calc(100% - 24px) center}',
          );
          return;
        }
      }
      if (path === '/second') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(
          '<!doctype html><title>Second page</title><h1 id="second">A new source document</h1><button id="next-click" onclick="this.textContent=\'Clicked once\'">New action</button>',
        );
        return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader(
        'Set-Cookie',
        'session=source-only; HttpOnly; SameSite=Lax; Path=/',
      );
      response.end(`<!doctype html><html><head><title>Workspace · Juniper</title><link rel="stylesheet" href="/private/theme.css"><style>
        *{box-sizing:border-box}body{margin:0;background:#f8faf9;color:#263d36;font:14px/1.5 FixtureInter,Arial,sans-serif}button,input,select{font:inherit}button{cursor:pointer}header{height:78px;display:flex;align-items:center;padding:0 48px;background:#fff;border-bottom:1px solid #e6ece9;gap:12px}header img{width:32px;height:32px}header strong{font-size:19px;letter-spacing:-.6px}header nav{margin-left:48px;display:flex;gap:30px;font-size:12px;color:#81918b}header nav b{color:#2b745d}header .avatar{margin-left:auto;width:30px;height:30px;display:grid;place-items:center;border-radius:50%;background:#e8eee9;font-size:11px;color:#73927e}main{max-width:1130px;margin:0 auto;padding:42px 30px}.eyebrow{font-size:10px;letter-spacing:1.5px;color:#96a79f}.intro{display:flex;justify-content:space-between;align-items:center;margin-bottom:27px}h1{font-size:27px;letter-spacing:-.8px;margin:7px 0}p{color:#86988f;font-size:12px;margin:0}.button{border:1px solid #d8e3dd;background:white;color:#5c7b6a;padding:9px 14px;border-radius:6px;font-size:12px}.primary{background:#29795f;color:white;border-color:#29795f}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.card{background-color:#fff;border:1px solid #e1e9e4;border-radius:10px;padding:22px}.card .label{font-size:11px;color:#899c90}.card .number{font-size:30px;letter-spacing:-1px;margin:7px 0}.card .hint{font-size:10px;color:#68a088}.content{display:grid;grid-template-columns:1.5fr 1fr;gap:20px;margin-top:24px}.section-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:23px;font-size:13px}.pill{background:#edf6f0;color:#729982;padding:3px 8px;border-radius:4px;font-size:9px}.row{display:flex;align-items:center;gap:13px;border-bottom:1px solid #edf1ee;padding:15px 0}.row:last-child{border-bottom:0}.project-icon{width:33px;height:33px;border-radius:7px;background:#edf2ff;color:#91a0c7;display:grid;place-items:center}.row-name{font-size:12px}.row p{font-size:10px;margin-top:3px}.row .pill{margin-left:auto}label{font-size:10px;color:#84988b;display:block;margin:12px 0 6px}input,select{width:100%;padding:8px 10px;border:1px solid #dae5df;border-radius:5px;background:white;color:#527161;font-size:12px;outline:0}input:focus,select:focus{border-color:#80ae99}.settings button{margin-top:20px;width:100%}#result{min-height:18px;margin-top:10px;color:#3e9470;font-size:11px}.lower{display:flex;gap:20px;margin-top:24px}#long{height:650px;margin-top:25px;border-top:1px solid #e4ebe7;padding-top:25px}#unsupported{margin-top:35px}canvas{width:190px;height:70px}
        </style></head><body><header><img id="private-image" src="/private/brand.svg"><strong>juniper</strong><nav><b>Overview</b><span>Projects</span><span>Activity</span><span>Settings</span></nav><div class="avatar">JL</div></header><main><div class="intro"><div><span class="eyebrow">WORKSPACE / OVERVIEW</span><h1>Good morning, Jamie.</h1><p>Here’s what’s happening across your workspace today.</p></div><button id="count" class="button primary">Create report <span id="count-value">0</span></button></div><div class="stats"><div class="card private-card"><span class="label">Active projects</span><div class="number">12</div><span class="hint">↑ 2 this month</span></div><div class="card"><span class="label">Tasks completed</span><div class="number">148</div><span class="hint">↑ 18% from last month</span></div><div class="card"><span class="label">Team members</span><div class="number">8</div><span class="hint">All systems connected</span></div></div><div class="content"><section class="card"><div class="section-title"><b>Your projects</b><span class="pill">3 RECENT</span></div><div class="row"><span class="project-icon">◈</span><div><span class="row-name">Design system</span><p>Updated 2 hours ago · 24 tasks</p></div><span class="pill">In progress</span></div><div class="row"><span class="project-icon">◇</span><div><span class="row-name">Customer portal</span><p>Updated yesterday · 16 tasks</p></div><span class="pill">In review</span></div><div class="row"><span class="project-icon">▧</span><div><span class="row-name">September release</span><p>Updated yesterday · 8 tasks</p></div><span class="pill">Planning</span></div></section><form id="settings" class="card settings"><div class="section-title"><b>Workspace settings</b><span class="pill">LIVE</span></div><label for="name">Workspace name</label><input id="name" name="name" placeholder="Enter a workspace name" autocomplete="off"><label for="region">Region</label><select id="region"><option value="us">US East</option><option value="eu">Europe</option><option value="ap">Asia Pacific</option></select><button id="save" class="button primary" type="submit">Save changes</button><div id="result" aria-live="polite"></div></form></div><div class="lower"><a id="next" href="/second">Open next page →</a><button id="mutate" class="button">Add a live update</button></div><div id="updates"></div><div id="unsupported"><canvas></canvas><iframe src="about:blank" width="190" height="70"></iframe></div><section id="long"><h2>Source scroll position</h2><p id="scroll-target">This section remains in the source document.</p></section></main><script>
        window.fixtureRuns=(window.fixtureRuns||0)+1; window.trustedClicks=[];
        document.querySelector('#count').addEventListener('click',e=>{window.trustedClicks.push(e.isTrusted);document.querySelector('#count-value').textContent=String(window.trustedClicks.length)});
        document.querySelector('#settings').addEventListener('submit',async e=>{e.preventDefault();const response=await fetch('/submit',{method:'POST',body:document.querySelector('#name').value+'|'+document.querySelector('#region').value});if(response.ok)document.querySelector('#result').textContent='Changes saved on the source';});
        document.querySelector('#mutate').addEventListener('click',()=>{const p=document.createElement('p');p.id='live-update';p.textContent='Live update from the source';document.querySelector('#updates').append(p);});
        </script></body></html>`);
    })().catch(() => {
      response.writeHead(500);
      response.end('Fixture failure');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    submissions,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
