import { requireNativeView } from 'expo';
import * as React from 'react';

import { DummyModuleViewProps } from './DummyModule.types';

const NativeView: React.ComponentType<DummyModuleViewProps> =
  requireNativeView('DummyModule');

export default function DummyModuleView(props: DummyModuleViewProps) {
  return <NativeView {...props} />;
}
