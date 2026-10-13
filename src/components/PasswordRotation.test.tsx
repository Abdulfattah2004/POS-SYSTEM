import {afterEach,it,expect,vi} from 'vitest';
import {render,fireEvent,cleanup,waitFor} from '@testing-library/react';
import PasswordRotation from './PasswordRotation';
import {invoke} from '@tauri-apps/api/core';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('mismatching passwords never call native credential mutation',()=>{
 const done=vi.fn();const view=render(<PasswordRotation onComplete={done}/>);fireEvent.change(view.getByLabelText('New password'),{target:{value:'new-safe-password'}});fireEvent.change(view.getByLabelText('Confirm password'),{target:{value:'different-password'}});fireEvent.submit(view.container.querySelector('form')!);expect(invoke).not.toHaveBeenCalled();expect(view.getByRole('alert')).toHaveTextContent('matching passwords');expect(done).not.toHaveBeenCalled();
});
it('a native password failure stays visible and does not log out or erase the form',async()=>{
 vi.mocked(invoke).mockRejectedValue(new Error('Synthetic native authentication failure'));const done=vi.fn();const view=render(<PasswordRotation onComplete={done}/>);for(const label of ['New password','Confirm password'])fireEvent.change(view.getByLabelText(label),{target:{value:'new-safe-password'}});fireEvent.submit(view.container.querySelector('form')!);await view.findByRole('alert');expect(done).not.toHaveBeenCalled();expect(view.getByLabelText('New password')).toHaveValue('new-safe-password');expect(view.getByRole('button')).not.toBeDisabled();
});
it('matching strong passwords change only the current native account then require a new sign-in',async()=>{
 vi.mocked(invoke).mockResolvedValue(undefined);const done=vi.fn().mockResolvedValue(undefined);const view=render(<PasswordRotation onComplete={done}/>);for(const label of ['New password','Confirm password'])fireEvent.change(view.getByLabelText(label),{target:{value:'new-safe-password'}});fireEvent.submit(view.container.querySelector('form')!);await waitFor(()=>expect(done).toHaveBeenCalledOnce());expect(invoke).toHaveBeenCalledExactlyOnceWith('change_local_password',{password:'new-safe-password'});
});
