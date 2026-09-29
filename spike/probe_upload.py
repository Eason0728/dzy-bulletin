# 用完即丟：base64 上傳探測
import base64, json, sys, time, urllib.request
URL='https://script.google.com/macros/s/AKfycbwjSqM-r4kL8Xep7mejf3rG_W09G1dLveC8DcZy25kF0hT_tzykY759gIlySkRkqICr/exec'
MIME={'pdf':'application/pdf','docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}
for path in sys.argv[1:]:
    raw=open(path,'rb').read(); name=path.split('/')[-1]
    body=json.dumps({'action':'b64','name':name,'mime':MIME[name.rsplit('.',1)[1]],'data':base64.b64encode(raw).decode()}).encode()
    t=time.time()
    try:
        req=urllib.request.Request(URL,data=body,headers={'Content-Type':'text/plain'})
        r=urllib.request.urlopen(req,timeout=300).read().decode()
        try: j=json.loads(r); print(name, len(raw), 'bytes | 往返', round(time.time()-t,1),'s |', json.dumps({k:j.get(k) for k in ('ok','error','ms','size','preview','meta')},ensure_ascii=False))
        except: print(name,'非 JSON 回應:', r[:300].replace('\n',' '))
    except Exception as e: print(name,'例外',round(time.time()-t,1),'s',e)
