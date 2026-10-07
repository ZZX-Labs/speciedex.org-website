"""One writer per archive across processes; the kernel releases crashed writers."""
from __future__ import annotations
import os
from pathlib import Path
from functools import wraps

def guarded_init(function):
    @wraps(function)
    def initialize(self,*args,**kwargs):
        try:return function(self,*args,**kwargs)
        except BaseException:
            database=getattr(self,'database',None)
            if database:
                try:database.close()
                except Exception:pass
            lock=getattr(self,'_process_lock',None)
            if lock:lock.close()
            raise
    return initialize

class ArchiveLock:
    def __init__(self, root: Path):
        root.mkdir(parents=True,exist_ok=True)
        self.handle=(root/'.writer.lock').open('a+b')
        try:
            if os.name=='nt':
                import msvcrt
                if not self.handle.tell():self.handle.write(b'\0');self.handle.flush()
                self.handle.seek(0);msvcrt.locking(self.handle.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(self.handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:
            self.handle.close()
            raise RuntimeError('Another process is writing this archive; retry after it finishes') from None
    def close(self):
        if self.handle.closed:return
        if os.name=='nt':
            import msvcrt
            self.handle.seek(0);msvcrt.locking(self.handle.fileno(),msvcrt.LK_UNLCK,1)
        else:
            import fcntl
            fcntl.flock(self.handle,fcntl.LOCK_UN)
        self.handle.close()
    def __del__(self):
        if hasattr(self,'handle') and not self.handle.closed:self.handle.close()
