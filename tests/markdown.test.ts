import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import type {WindowLike} from 'dompurify';
import {createMarkdownRenderer} from '../src/markdown.ts';

test('the exact preview/detail pipeline supports Markdown and inert task boxes',()=>{
  const dom=new JSDOM('<!doctype html><body></body>',{url:'https://board.example'});
  try{
    const render=createMarkdownRenderer(dom.window as unknown as WindowLike);
    const output=render('# Hello\n\n**Bold** and _italic_.\n\n- [x] Finished\n- [ ] Later\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nalert("code, not execution");\n```');
    assert.equal(output.querySelector('h1')!.textContent,'Hello');assert(output.querySelector('strong'));assert(output.querySelector('em'));assert(output.querySelector('table'));assert(output.querySelector('pre code'));
    const boxes=output.querySelectorAll('input');assert.equal(boxes.length,2);boxes.forEach(box=>{assert.equal(box.type,'checkbox');assert(box.disabled);});assert(boxes[0].checked);
  }finally{dom.window.close();}
});

test('raw HTML, executable URLs, images, SVG, forms, and event handlers cannot become active content',()=>{
  const dom=new JSDOM('<!doctype html><body></body>',{url:'https://board.example'});
  try{
    const render=createMarkdownRenderer(dom.window as unknown as WindowLike);
    const attacks=[
      '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<svg><a onmouseover="alert(1)">x</a></svg>',
      '[bad](javascript:alert(1))','[bad](jav&#x61;script:alert%281%29)','![tracker](https://tracker.example/pixel.png)',
      '<iframe src="https://evil.example"></iframe>','<form><input autofocus onfocus=alert(1)></form>',
      '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
      '[bad](data:text/html,test)','<style>body{display:none}</style>'
    ];
    for(const attack of attacks){const output=render(attack);assert.equal(output.querySelectorAll('script,img,svg,math,iframe,form,style,object,embed').length,0,attack);output.querySelectorAll('*').forEach(el=>{for(const attr of el.attributes)assert(!attr.name.startsWith('on'));});output.querySelectorAll('a[href]').forEach(a=>assert(/^https?:/.test(a.getAttribute('href')!)));}
    const link=render('[safe](https://example.com)').querySelector('a')!;assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');assert.equal(link.getAttribute('referrerpolicy'),'no-referrer');
    const image=render('![sketch](https://example.com/image.png)');assert(!image.querySelector('img'));assert.equal(image.querySelector('a')!.textContent,'sketch (image)');
  }finally{dom.window.close();}
});
