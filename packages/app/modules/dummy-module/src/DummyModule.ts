import { NativeModule, requireNativeModule } from 'expo';

import { DummyModuleEvents } from './DummyModule.types';

declare class DummyModule extends NativeModule<DummyModuleEvents> {
  PI: number;
  hello(): string;
  setValueAsync(value: string): Promise<void>;
}

// This call loads the native module object from the JSI.
export default requireNativeModule<DummyModule>('DummyModule');
