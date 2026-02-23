import { registerWebModule, NativeModule } from 'expo';

import { ChangeEventPayload } from './PocketTerminalModule.types';

type PocketTerminalModuleEvents = {
  onChange: (params: ChangeEventPayload) => void;
}

class PocketTerminalModule extends NativeModule<PocketTerminalModuleEvents> {
  PI = Math.PI;
  async setValueAsync(value: string): Promise<void> {
    this.emit('onChange', { value });
  }
  hello() {
    return 'Hello world! 👋';
  }
};

export default registerWebModule(PocketTerminalModule, 'PocketTerminalModule');
