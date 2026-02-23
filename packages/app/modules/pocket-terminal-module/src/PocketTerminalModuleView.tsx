import { requireNativeView } from 'expo';
import * as React from 'react';

import { PocketTerminalModuleViewProps } from './PocketTerminalModule.types';

const NativeView: React.ComponentType<PocketTerminalModuleViewProps> =
  requireNativeView('PocketTerminalModule');

export default function PocketTerminalModuleView(props: PocketTerminalModuleViewProps) {
  return <NativeView {...props} />;
}
