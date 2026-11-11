// Synthetic local site for the M3 browser-tool integration test. No credentials/data.
const http = require('node:http');
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Whippet M3 fixture</title>
<h1>Whippet demo checklist</h1><label for="task">Task name</label><input id="task">
<button id="add">Add task</button><ul id="tasks"></ul><p role="status">0 tasks</p>
<script>let count=0;document.querySelector('#add').onclick=()=>{const input=document.querySelector('#task');if(!input.value.trim())return;const li=document.createElement('li');li.textContent=input.value;document.querySelector('#tasks').append(li);input.value='';document.querySelector('[role=status]').textContent=(++count)+' tasks';};</script></html>`;
http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html);}).listen(8080,'0.0.0.0');
