import {afterEach,expect,it} from 'vitest';
import {act,cleanup,render} from '@testing-library/react';
import InlineNotifications from './InlineNotifications';
import {toast,dismissNotice,getNotices} from '@/lib/notifications';
afterEach(()=>{cleanup();getNotices().forEach(notice=>dismissNotice(notice.id));});
it('removes global banners without dropping internal diagnostic errors',()=>{
 const view=render(<InlineNotifications />);act(()=>{toast.error('Checkout could not be committed.');toast.success('Scanner ready');});
 expect(view.container).toBeEmptyDOMElement();
 expect(getNotices().some(notice=>notice.kind==='error'&&notice.message==='Checkout could not be committed.')).toBe(true);
});
