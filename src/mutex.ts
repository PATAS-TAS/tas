// mutex.ts

export class Mutex {
    private mutex = Promise.resolve();
  
    async acquire(): Promise<() => void> {
      let release: (() => void) | undefined;
  
      const newMutex = new Promise<void>(resolve => {
        release = () => resolve();
      });
  
      const oldMutex = this.mutex;
      this.mutex = newMutex;
  
      await oldMutex;
  
      return () => {
        if (release) release();
      };
    }
  }