'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Users, Plus, X, Mail, Send, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StepWrapper } from '../shared/step-wrapper';
import { updateUserContext } from '../shared/context';

export const TeamInvitationStep = () => {
  const [inviteEmails, setInviteEmails] = useState<string[]>(['']);
  const [isSkipping, setIsSkipping] = useState(false);
  const [invitesSent, setInvitesSent] = useState(false);

  const addEmailField = () => {
    setInviteEmails([...inviteEmails, '']);
  };

  const updateEmail = (index: number, email: string) => {
    const updated = [...inviteEmails];
    updated[index] = email;
    setInviteEmails(updated);
  };

  const removeEmail = (index: number) => {
    if (inviteEmails.length > 1) {
      const updated = inviteEmails.filter((_, i) => i !== index);
      setInviteEmails(updated);
    }
  };

  const sendInvites = () => {
    const validEmails = inviteEmails.filter(email => email.trim() && email.includes('@'));
    updateUserContext({ invitedTeammates: validEmails });
    console.log('Sending invites to:', validEmails);
    setInvitesSent(true);
    
    // Simulate sending invites
    setTimeout(() => {
      setInvitesSent(false);
    }, 2000);
  };

  const skipInvitation = () => {
    setIsSkipping(true);
    updateUserContext({ invitedTeammates: [] });
    
    // Auto-advance after showing skip message
    setTimeout(() => {
      setIsSkipping(false);
    }, 1500);
  };

  const validEmails = inviteEmails.filter(email => email.trim() && email.includes('@'));
  const hasValidEmails = validEmails.length > 0;

  return (
    <StepWrapper>
      <div className="text-center space-y-8 max-w-2xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <UserPlus className="h-12 w-12 text-primary mx-auto mb-4" />
          <h2 className="text-2xl font-bold mb-3">Invite Your Team</h2>
          <p className="text-muted-foreground max-w-lg mx-auto">
            Collaboration makes everything better. Invite your teammates to join your AI workforce 
            and work together more efficiently.
          </p>
        </motion.div>

        {/* Success state */}
        {invitesSent && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 rounded-lg p-6"
          >
            <Send className="h-8 w-8 text-green-600 mx-auto mb-3" />
            <h3 className="font-semibold text-green-800 dark:text-green-300 mb-2">
              Invitations Sent!
            </h3>
            <p className="text-sm text-green-700 dark:text-green-400">
              Your teammates will receive an invitation email to join your AI workforce.
            </p>
          </motion.div>
        )}

        {/* Skip state */}
        {isSkipping && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg p-6"
          >
            <Users className="h-8 w-8 text-blue-600 mx-auto mb-3" />
            <h3 className="font-semibold text-blue-800 dark:text-blue-300 mb-2">
              No worries!
            </h3>
            <p className="text-sm text-blue-700 dark:text-blue-400">
              You can always invite teammates later from your dashboard.
            </p>
          </motion.div>
        )}

        {/* Invitation form */}
        {!invitesSent && !isSkipping && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="space-y-6"
          >
            {/* Benefits */}
            <div className="grid md:grid-cols-3 gap-4 mb-8">
              <Card className="bg-primary/5 border-primary/20">
                <CardContent className="p-4 text-center">
                  <Users className="h-6 w-6 text-primary mx-auto mb-2" />
                  <h4 className="font-medium text-sm mb-1">Shared Workspace</h4>
                  <p className="text-xs text-muted-foreground">
                    Work together on projects and share AI agents
                  </p>
                </CardContent>
              </Card>
              
              <Card className="bg-primary/5 border-primary/20">
                <CardContent className="p-4 text-center">
                  <Mail className="h-6 w-6 text-primary mx-auto mb-2" />
                  <h4 className="font-medium text-sm mb-1">Real-time Updates</h4>
                  <p className="text-xs text-muted-foreground">
                    Get notified when agents complete tasks
                  </p>
                </CardContent>
              </Card>
              
              <Card className="bg-primary/5 border-primary/20">
                <CardContent className="p-4 text-center">
                  <Send className="h-6 w-6 text-primary mx-auto mb-2" />
                  <h4 className="font-medium text-sm mb-1">Easy Collaboration</h4>
                  <p className="text-xs text-muted-foreground">
                    Assign agents to team members and track progress
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Email inputs */}
            <div className="space-y-4">
              <Label className="text-sm font-medium">Team member email addresses</Label>
              
              {inviteEmails.map((email, index) => (
                <motion.div
                  key={index}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.1 }}
                  className="flex gap-2"
                >
                  <Input
                    type="email"
                    placeholder="teammate@company.com"
                    value={email}
                    onChange={(e) => updateEmail(index, e.target.value)}
                    className="flex-1"
                  />
                  {inviteEmails.length > 1 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => removeEmail(index)}
                      className="px-3"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </motion.div>
              ))}
              
              <Button
                variant="outline"
                onClick={addEmailField}
                className="w-full border-dashed"
                disabled={inviteEmails.length >= 10}
              >
                <Plus className="h-4 w-4 mr-2" />
                Add another email
              </Button>
            </div>

            {/* Action buttons */}
            <div className="flex flex-col sm:flex-row gap-3 pt-4">
              <Button
                onClick={sendInvites}
                disabled={!hasValidEmails}
                className="flex-1 flex items-center gap-2"
              >
                <Send className="h-4 w-4" />
                Send {validEmails.length} invitation{validEmails.length !== 1 ? 's' : ''}
              </Button>
              
              <Button
                variant="outline"
                onClick={skipInvitation}
                className="flex-1"
              >
                Skip for now
              </Button>
            </div>

            {/* Email validation feedback */}
            {inviteEmails.some(email => email.trim()) && (
              <div className="text-sm">
                {hasValidEmails ? (
                  <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                    <div className="w-2 h-2 bg-green-500 rounded-full" />
                    {validEmails.length} valid email{validEmails.length !== 1 ? 's' : ''} ready to send
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                    <div className="w-2 h-2 bg-amber-500 rounded-full" />
                    Please enter valid email addresses
                  </div>
                )}
              </div>
            )}
          </motion.div>
        )}
      </div>
    </StepWrapper>
  );
};

