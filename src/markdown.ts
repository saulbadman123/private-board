import createDOMPurify from 'dompurify';
import type { WindowLike } from 'dompurify';
import { parsedMarkdown, safeLink } from '../shared/markdown.ts';

export function createMarkdownRenderer(window: WindowLike): (source: string) => DocumentFragment {
  const purifier=createDOMPurify(window);
  purifier.addHook('afterSanitizeAttributes',node=>{
    if (node.nodeName==='A') {
      const href=node.getAttribute('href');
      if (!href || !safeLink(href)) node.removeAttribute('href');
      else { node.setAttribute('target','_blank'); node.setAttribute('rel','noopener noreferrer'); node.setAttribute('referrerpolicy','no-referrer'); }
    }
    if (node.nodeName==='INPUT') { node.setAttribute('type','checkbox');node.setAttribute('disabled',''); }
  });
  return source=>purifier.sanitize(parsedMarkdown(source),{
    ALLOWED_TAGS:['p','br','hr','h1','h2','h3','h4','h5','h6','strong','em','del','a','ul','ol','li','blockquote','pre','code','table','thead','tbody','tr','th','td','input'],
    ALLOWED_ATTR:['href','target','rel','referrerpolicy','start','disabled','checked','type','aria-label'],
    ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false,RETURN_DOM_FRAGMENT:true
  });
}
let renderer: ReturnType<typeof createMarkdownRenderer> | undefined;
export function renderMarkdown(target: HTMLElement, source: string) {
  renderer ??= createMarkdownRenderer(window);
  target.replaceChildren(renderer(source));
}
