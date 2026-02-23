import { registerWebModule, NativeModule } from 'expo';

import { ChangeEventPayload } from './DummyModule.types';

type DummyModuleEvents = {
  onChange: (params: ChangeEventPayload) => void;
}

class DummyModule extends NativeModule<DummyModuleEvents> {
  PI = Math.PI;
  async setValueAsync(value: string): Promise<void> {
    this.emit('onChange', { value });
  }
  hello() {
    return 'Hello world! 👋';
  }
};

export default registerWebModule(DummyModule, 'DummyModule');
