export function maskPageScript(selectors: string[], secrets: string[]): string {
  return `(() => {
    const selectors=${JSON.stringify(selectors)},secrets=${JSON.stringify(secrets)},documents=[document],nodes=new Set(),unreadableFrames=[];
    for(let index=0;index<documents.length;index++) {
      const page=documents[index];
      for(const frame of page.querySelectorAll('iframe,frame')) {
        let child;
        try { child=frame.contentDocument; } catch {}
        if(child&&!documents.includes(child)) {
          if(documents.length<16) documents.push(child);
          else frame.style.setProperty('visibility','hidden','important');
        }
        else if(!child) unreadableFrames.push(frame);
      }
      for(const e of page.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"],input[autocomplete="username"],input[data-otto-login-field]')) nodes.add(e);
      for(const selector of selectors) { try { for(const e of page.querySelectorAll(selector)) nodes.add(e); } catch {} }
      for(const e of page.querySelectorAll('input,textarea')) if(secrets.some(secret=>secret&&String(e.value??e.textContent??'').includes(secret))) nodes.add(e);
    }
    if(nodes.size>40) throw new Error('Too many protected fields');
    const inputValues=[...nodes].map(e=>String(e.value??e.textContent??'')).filter(Boolean),values=[],grouped=new Set();
    if(inputValues.some(value=>value.length>8192)) throw new Error('Protected field exceeds limit');
    for(const e of nodes) {
      if(grouped.has(e)) continue;
      const marker=e.getAttribute('data-otto-login-field'),siblings=marker?.startsWith('otp-')&&e.parentElement?[...e.parentElement.querySelectorAll('input')].filter(n=>nodes.has(n)&&n.parentElement===e.parentElement&&n.getAttribute('data-otto-login-field')===marker):[];
      if(siblings.length>=4&&siblings.length<=8&&siblings.every(n=>n.maxLength===1)) {
        siblings.forEach(n=>grouped.add(n));
        const value=siblings.map(n=>String(n.value??'')).join('');
        if(value) values.push(value);
      } else {
        const value=String(e.value??e.textContent??'');
        if(value) values.push(value);
      }
    }
    for(const value of values) if(!secrets.includes(value)) secrets.push(value);
    if(secrets.length) for(const frame of unreadableFrames) frame.style.setProperty('visibility','hidden','important');
    for(const e of nodes) {
      e.style.setProperty('color','transparent','important');
      e.style.setProperty('text-shadow','none','important');
      e.style.setProperty('-webkit-text-security','disc','important');
    }
    for(const page of documents) if(page.body&&secrets.length) {
      const walker=page.createTreeWalker(page.body,NodeFilter.SHOW_TEXT);
      while(walker.nextNode()) {
        const node=walker.currentNode,parent=node.parentElement;
        if(parent&&!['SCRIPT','STYLE'].includes(parent.tagName)&&secrets.some(secret=>secret&&node.textContent.includes(secret))) {
          parent.style.setProperty('color','transparent','important');
          parent.style.setProperty('text-shadow','none','important');
        }
      }
    }
    return {masked:true,values,inputValues};
  })()`;
}

export function maskSnapshotInputValues(snapshot: string, values: string[]): string {
  const protectedValues = new Set(values);
  return snapshot
    .split('\n')
    .map((line) => {
      const match =
        /^(\s*-\s+(?:textbox|searchbox|spinbutton|combobox)\b.*\[[^\]\n]*\]):\s*(.*)$/.exec(line);
      if (!match) return line;
      let value = match[2].trim();
      if (value.startsWith('"')) {
        try {
          const decoded: unknown = JSON.parse(value);
          if (typeof decoded === 'string') value = decoded;
        } catch {}
      }
      return protectedValues.has(value) ? `${match[1]}: [redacted]` : line;
    })
    .join('\n');
}
