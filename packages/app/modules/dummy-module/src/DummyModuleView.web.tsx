import * as React from 'react';

import { DummyModuleViewProps } from './DummyModule.types';

export default function DummyModuleView(props: DummyModuleViewProps) {
  return (
    <div>
      <iframe
        style={{ flex: 1 }}
        src={props.url}
        onLoad={() => props.onLoad({ nativeEvent: { url: props.url } })}
      />
    </div>
  );
}
