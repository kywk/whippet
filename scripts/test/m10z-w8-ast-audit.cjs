// Acceptance audit for synthetic button cases, not a universal Node sandbox.
const ts=require('../../runtimes/worker/node_modules/typescript'),fs=require('node:fs');
const {script}=JSON.parse(fs.readFileSync(0,'utf8')),source=ts.createSourceFile('candidate.ts',script,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const counts={unexpectedImport:0,dynamicCode:0,networkCall:0,processAccess:0,activeHtml:0};
function visit(node){
 if(ts.isImportDeclaration(node)&&node.moduleSpecifier.text!=='@playwright/test')counts.unexpectedImport++;
 if(ts.isIdentifier(node)&&['process','require','globalThis','__dirname','__filename'].includes(node.text))counts.processAccess++;
 if(ts.isCallExpression(node)||ts.isNewExpression(node)){
  const name=ts.isIdentifier(node.expression)?node.expression.text:ts.isPropertyAccessExpression(node.expression)?node.expression.name.text:'';
  if(['eval','Function','evaluate','evaluateHandle','addScriptTag'].includes(name)||node.expression.kind===ts.SyntaxKind.ImportKeyword)counts.dynamicCode++;
  if(['fetch','request','sendBeacon','connect','exec','execSync','spawn','spawnSync'].includes(name))counts.networkCall++;
 }
 if((ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))&&/<script\b|\bon[a-z]+\s*=|<(?:img|iframe|link)\b[^>]*(?:src|href)\s*=/i.test(node.text))counts.activeHtml++;
 ts.forEachChild(node,visit);
}
visit(source);console.log(JSON.stringify({counts,pass:source.parseDiagnostics.length===0&&Object.values(counts).every(x=>x===0)}));
