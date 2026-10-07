#!/usr/bin/env python3
"""Capture actual native CMatrix output with bounded browser playback timing."""
from __future__ import annotations
import argparse,base64,fcntl,json,os,pty,select,signal,struct,tempfile,termios,time
from datetime import datetime,timezone
from pathlib import Path

def capture(binary: str, output: Path, seconds: int, commit: str) -> dict:
    columns,rows=120,40
    pid,master=pty.fork()
    if pid==0:
        os.environ.update(TERM='xterm-256color',LANG='C.UTF-8')
        fcntl.ioctl(1,termios.TIOCSWINSZ,struct.pack('HHHH',rows,columns,0,0))
        try:os.execv(binary,[binary,'-b','-u','2'])
        except OSError:os._exit(127)
    os.set_blocking(master,False)
    frames=[];pending=bytearray();started=previous=time.monotonic();next_frame=started+1/30;total=0;early=False
    try:
        while time.monotonic()-started<seconds:
            current=time.monotonic()
            ready,_,_=select.select([master],[],[],max(0,min(next_frame-current,seconds-(current-started))))
            if ready:
                try:data=os.read(master,65536)
                except BlockingIOError:continue
                except OSError:early=True;break
                if not data:early=True;break
                pending.extend(data);total+=len(data)
                if total>128*1024**2:raise RuntimeError('Native recording exceeds safety bound')
            current=time.monotonic()
            if current>=next_frame:
                if pending:
                    frames.append({'delay_ms':max(5,round((current-previous)*1000)),'data':base64.b64encode(pending).decode('ascii')})
                    pending.clear();previous=current
                next_frame=current+1/30
        if pending:frames.append({'delay_ms':max(5,round((time.monotonic()-previous)*1000)),'data':base64.b64encode(pending).decode('ascii')})
    finally:
        try:os.kill(pid,signal.SIGTERM)
        except ProcessLookupError:pass
        deadline=time.monotonic()+1
        while True:
            child,_=os.waitpid(pid,os.WNOHANG)
            if child:break
            if time.monotonic()>=deadline:
                try:os.kill(pid,signal.SIGKILL)
                except ProcessLookupError:pass
                os.waitpid(pid,0);break
            time.sleep(.02)
        os.close(master)
    data=b''.join(base64.b64decode(f['data']) for f in frames)
    if early or len(frames)<seconds*10 or b'\x1b[' not in data or b'error while loading' in data:
        raise RuntimeError('Native CMatrix did not produce a healthy animation; previous recording retained')
    frames[-1]['delay_ms']+=seconds*1000-sum(f['delay_ms'] for f in frames)
    if not all(5<=f['delay_ms']<=2000 for f in frames):raise RuntimeError('Invalid playback timing')
    payload={'schema':'speciedex.cmatrix.recording.v1','generator':'https://github.com/abishekvashok/cmatrix','upstream_commit':commit,'generated_at':datetime.now(timezone.utc).isoformat(),'columns':columns,'rows':rows,'duration_seconds':seconds,'frame_count':len(frames),'loop':True,'frames':frames}
    output.parent.mkdir(parents=True,exist_ok=True)
    descriptor,temporary=tempfile.mkstemp(dir=output.parent,prefix='.recording-')
    try:
        with os.fdopen(descriptor,'w',encoding='utf-8') as handle:
            json.dump(payload,handle,separators=(',',':'));handle.write('\n');handle.flush();os.fsync(handle.fileno())
        os.chmod(temporary,0o644);os.replace(temporary,output)
    finally:
        if os.path.exists(temporary):os.unlink(temporary)
    return {k:v for k,v in payload.items() if k!='frames'}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary',default=os.getenv('CMATRIX_BINARY','cmatrix'))
    parser.add_argument('--output',type=Path,default=Path(os.getenv('CMATRIX_OUTPUT','static/data/cmatrix/cmatrix-recording.json')))
    parser.add_argument('--seconds',type=int,default=int(os.getenv('CMATRIX_SECONDS','12')))
    parser.add_argument('--commit',default=os.getenv('CMATRIX_COMMIT','native-cmatrix-2.0'))
    args=parser.parse_args()
    if not 3<=args.seconds<=60:parser.error('--seconds must be between 3 and 60')
    import shutil
    binary=shutil.which(args.binary)
    if not binary:parser.error('Native cmatrix executable unavailable')
    print(json.dumps(capture(binary,args.output,args.seconds,args.commit),indent=2))
