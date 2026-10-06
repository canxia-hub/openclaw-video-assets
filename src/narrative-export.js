import { randomUUID } from "node:crypto";

const xml = (s) => String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]));
const crcTable=Array.from({length:256},(_,i)=>{let c=i;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crc32=b=>{let c=0xffffffff;for(const n of b)c=crcTable[(c^n)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
// EPUB uses a stored, first-entry mimetype. UTF-8 flag is set; no vendor dependency or shell ZIP.
export function zipStored(entries) {
  const chunks=[],central=[];let offset=0;
  for(const [filename,value] of entries) {
    const name=Buffer.from(filename),body=Buffer.isBuffer(value)?value:Buffer.from(value),crc=crc32(body);
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(0x21,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(body.length,18);header.writeUInt32LE(body.length,22);header.writeUInt16LE(name.length,26);
    chunks.push(header,name,body);
    const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(0x21,14);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(body.length,20);directory.writeUInt32LE(body.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42);
    central.push(directory,name);offset+=header.length+name.length+body.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...chunks,directory,end]);
}
export function createEpub({title,chapters}) {
  const bookId="urn:uuid:"+randomUUID();
  const entries=[
    ["mimetype","application/epub+zip"],
    ["META-INF/container.xml",'<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>']
  ];
  const names=chapters.map((_,i)=>"chapter-"+(i+1)+".xhtml");
  const links=chapters.map((c,i)=>'<li><a href="'+names[i]+'">'+xml(c.title)+'</a></li>').join("");
  entries.push(["EPUB/nav.xhtml",'<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN" xml:lang="zh-CN"><head><title>目录</title></head><body><nav epub:type="toc" id="toc"><h1>'+xml(title)+'</h1><ol>'+links+'</ol></nav></body></html>']);
  chapters.forEach((c,i)=>entries.push(["EPUB/"+names[i],'<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN" xml:lang="zh-CN"><head><title>'+xml(c.title)+'</title></head><body><h1>'+xml(c.title)+'</h1>'+c.body.split(/\r?\n/).map(line=>"<p>"+xml(line)+"</p>").join("")+"</body></html>"]));
  const items=names.map((name,i)=>'<item id="c'+i+'" href="'+name+'" media-type="application/xhtml+xml"/>').join("");
  const spine=names.map((_,i)=>'<itemref idref="c'+i+'"/>').join("");
  entries.push(["EPUB/package.opf",'<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="zh-CN"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">'+bookId+'</dc:identifier><dc:title>'+xml(title)+'</dc:title><dc:language>zh-CN</dc:language><meta property="dcterms:modified">'+new Date().toISOString().replace(/\.\d+Z$/,"Z")+'</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'+items+'</manifest><spine>'+spine+'</spine></package>']);
  return zipStored(entries);
}
